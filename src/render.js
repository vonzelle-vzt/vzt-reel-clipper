import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, log, FFMPEG } from "./util.js";
import { buildAss, buildTitleAss } from "./ass.js";

/**
 * Render a single vertical captioned clip.
 * @param {string} source   path to the full source video
 * @param {object} clip     { start, end, title }
 * @param {Array}  words    full word list (absolute times) — sliced & rebased here
 * @param {string} outDir   output directory (also holds the temp .ass)
 * @param {string} outName  output file basename (no extension)
 */
/**
 * Build the filter chain that fits a (usually 16:9) source into the 1080x1920
 * vertical canvas.
 *
 *   smart   — track the subject and slide a 9:16 crop window to follow it
 *             (camera path planned in reframe.js, driven here via sendcmd)
 *   cover   — scale to fill, crop the overflow (good for centered talking heads)
 *   contain — scale the whole frame to fit, pad with black (nothing cut off;
 *             ideal for slides / screen-shares where edge content matters)
 *   blur    — fit the frame sharp, fill the bars with a blurred zoom of itself
 *
 * Shared with composite.js so the hype-reel compositor frames shots exactly the
 * way single-clip rendering does. Writing the `sendcmd` script is a side effect
 * (it must sit next to the output, referenced by bare name — see the Windows
 * filtergraph-escaping note in docs/ARCHITECTURE.md).
 *
 * @returns {string} a filter chain usable as -vf on a single video input
 */
export function buildFitFilter({ fit, reframe, outDir, outName }) {
  const useSmart =
    fit === "smart" && reframe && Array.isArray(reframe.keyframes) && reframe.keyframes.length > 0;
  if (useSmart) {
    const rf = reframe;
    const cmdName = `${outName}.cmd`;
    const lines = rf.keyframes.map((k) => `${k.t.toFixed(3)} crop x ${k.x};`).join("\n");
    writeFileSync(join(outDir, cmdName), lines + "\n", "utf8");
    return [
      `sendcmd=f=${cmdName}`,
      `crop=${rf.cropW}:${rf.cropH}:${rf.keyframes[0].x}:${rf.cropY ?? 0}`,
      "scale=1080:1920",
      "setsar=1",
    ].join(",");
  }
  if (fit === "contain") {
    return [
      "scale=1080:1920:force_original_aspect_ratio=decrease",
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black",
      "setsar=1",
    ].join(",");
  }
  if (fit === "blur") {
    return [
      "split=2[bg][fg]",
      "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20[bgb]",
      "[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs]",
      "[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1",
    ].join(";");
  }
  return ["scale=1080:1920:force_original_aspect_ratio=increase", "crop=1080:1920", "setsar=1"].join(",");
}

export async function renderClip(source, clip, words, outDir, outName, opts = {}) {
  const dur = clip.end - clip.start;

  // Words that fall inside this clip, rebased so the clip starts at t=0.
  const local = words
    .filter((w) => w.end > clip.start && w.start < clip.end)
    .map((w) => ({
      text: w.text,
      start: Math.max(0, w.start - clip.start),
      end: Math.min(dur, w.end - clip.start),
    }));

  // Pan & scan (smart) writes a `sendcmd` script next to the output; the crop's
  // x is stepped over time from it, all inside this single render pass.
  const baseVf = buildFitFilter({ fit: opts.fit, reframe: opts.reframe, outDir, outName });

  // Captions: word-by-word karaoke (speech mode) OR a static title banner
  // (sports / no-speech mode). Empty when both are off.
  let assContent = null;
  if (local.length) assContent = buildAss(local, opts.caption || {});
  else if (opts.staticTitle) assContent = buildTitleAss(opts.staticTitle, dur, opts.caption || {});

  let vf = baseVf;
  if (assContent) {
    const assName = `${outName}.ass`;
    writeFileSync(join(outDir, assName), assContent, "utf8");
    // Running with cwd=outDir lets us reference the .ass by bare name and dodge
    // Windows drive-letter/backslash escaping inside the ffmpeg filtergraph.
    // The ass filter chains onto the final video pad of baseVf.
    vf += `,ass=${assName}`;
  }

  const out = `${outName}.mp4`;
  const args = [
    "-y",
    "-ss", clip.start.toFixed(3),
    "-i", source,
    "-t", dur.toFixed(3),
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", opts.preset || "veryfast",
    "-crf", String(opts.crf ?? 20),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    out,
  ];

  log.info(`rendering ${out}  (${dur.toFixed(1)}s, ${local.length} caption words)`);
  await exec(FFMPEG, args, { cwd: outDir, check: true });
  return join(outDir, out);
}

/**
 * Stitch rendered clips (all identical 1080x1920 / codec) into one reel.
 * Uses the concat demuxer with stream copy — fast, no re-encode.
 */
export async function stitchReel(files, outDir, outName = "reel") {
  const listName = `${outName}.txt`;
  // concat demuxer needs forward slashes and 'file' lines.
  const list = files.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n");
  writeFileSync(join(outDir, listName), list, "utf8");
  const out = `${outName}.mp4`;
  await exec(
    FFMPEG,
    ["-y", "-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", "-movflags", "+faststart", out],
    { cwd: outDir, check: true },
  );
  return join(outDir, out);
}
