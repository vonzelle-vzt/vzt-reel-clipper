import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, log } from "./util.js";
import { buildAss, buildTitleAss } from "./ass.js";

/**
 * Render a single vertical captioned clip.
 * @param {string} source   path to the full source video
 * @param {object} clip     { start, end, title }
 * @param {Array}  words    full word list (absolute times) — sliced & rebased here
 * @param {string} outDir   output directory (also holds the temp .ass)
 * @param {string} outName  output file basename (no extension)
 */
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

  // Captions: word-by-word karaoke (speech mode) OR a static title banner
  // (sports / no-speech mode). Empty when both are off.
  const filters = [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "setsar=1",
  ];
  let assContent = null;
  if (local.length) assContent = buildAss(local, opts.caption || {});
  else if (opts.staticTitle) assContent = buildTitleAss(opts.staticTitle, dur, opts.caption || {});

  if (assContent) {
    const assName = `${outName}.ass`;
    writeFileSync(join(outDir, assName), assContent, "utf8");
    // Running with cwd=outDir lets us reference the .ass by bare name and dodge
    // Windows drive-letter/backslash escaping inside the ffmpeg filtergraph.
    filters.push(`ass=${assName}`);
  }
  const vf = filters.join(",");

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
  await exec("ffmpeg", args, { cwd: outDir, check: true });
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
    "ffmpeg",
    ["-y", "-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", "-movflags", "+faststart", out],
    { cwd: outDir, check: true },
  );
  return join(outDir, out);
}
