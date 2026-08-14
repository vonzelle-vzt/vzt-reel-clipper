import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec, log, FFMPEG, FFPROBE, ffprobeDuration } from "./util.js";
import { buildFitFilter, aspectSize } from "./render.js";
import { gradeFilter } from "./grade.js";
import { createSfxLibrary } from "./sfx.js";

/**
 * Reel assembly — turns an EDL from plan.js into one finished hype reel.
 *
 * This replaces `stitchReel`'s concat-with-stream-copy for hype mode. That
 * function could never grow into this: a stream copy cannot speed-ramp, cannot
 * cross-fade, cannot lay a music bed under the picture and cannot mix a sound
 * effect. Every pillar of the editing doctrine was blocked behind it.
 *
 * Two passes, following the pattern proven in vzt-reel-studio's stages:
 *
 *   PASS 1  each shot → a normalized 1080x1920 intermediate, with its speed
 *           ramp, framing and grade baked in. Durations are then MEASURED with
 *           ffprobe rather than assumed from the plan — ffmpeg rounds cuts to
 *           frame boundaries, and trusting the estimate is how reels end up
 *           drifting out of sync with the music.
 *
 *   PASS 2  join the shots, lay the music bed, mix the SFX, normalize loudness.
 *
 * Joining has a fast path and a fancy path:
 *   - all-hard-cuts → concat demuxer, stream copy. Exact and quick, and it is
 *     what the doctrine actually wants (cuts land on the beat).
 *   - any cross-fade → a uniform xfade chain. Each shot is rendered with an
 *     extra tail equal to its outgoing transition, which makes the arithmetic
 *     come out exactly: with xfade, out = A + B - d, so padding every shot's
 *     tail by the next transition cancels every d and the total collapses back
 *     to the sum of the planned slots. The offset of join i is then simply
 *     `shots[i].at`. Hard cuts inside that chain use a one-frame fade so the
 *     same arithmetic holds for them too — visually a cut, mathematically a
 *     transition.
 */

const FPS = 30;
const HARD_D = 1 / FPS; // one frame: a "cut" that keeps the xfade maths uniform
const XFADE_D = 0.3;
const WHIP_D = 0.15; // fast enough to read as a camera whip, not a dissolve
const FLASH_D = 0.10; // a blink, not a dissolve — long enough is already too long

/**
 * Filter that produces the slow-motion section.
 *
 * Plain `setpts` on 30fps source shows every frame twice at 0.5x, which reads
 * as stutter rather than slow motion — measured at 305 duplicate frames out of
 * 885 in a finished reel. Interpolating first gives real intermediate frames.
 *
 *   dup    — no interpolation. Fastest, judders.
 *   blend  — cross-faded tweens. ~30% slower, soft ghosting on fast motion.
 *   smooth — motion-compensated. Genuinely smooth, but ~40x slower to render,
 *            so it is opt-in for a final export rather than a draft.
 */
export function slowmoFilter(mode, speed) {
  const pts = `setpts=(PTS-STARTPTS)/${speed}`;
  if (mode === "smooth") {
    return `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,${pts}`;
  }
  if (mode === "blend") return `minterpolate=fps=60:mi_mode=blend,${pts}`;
  return pts;
}

/**
 * Map a planned transition to an ffmpeg xfade and its duration.
 *
 * `whip` uses a directional smooth-slide matching the direction the action
 * already travels, so it continues the camera move instead of interrupting it —
 * the "natural whip pan" rather than a canned effect. It is paired with a
 * whoosh cue from the planner, which is most of what sells it.
 */
export function transitionSpec(shot) {
  if (shot?.transition === "xfade") return { name: "fade", d: XFADE_D };
  if (shot?.transition === "whip") {
    return { name: shot.whipDir < 0 ? "smoothleft" : "smoothright", d: WHIP_D };
  }
  // FLASH CUT. Named repeatedly across editor breakdowns as the workhorse
  // accent — a white blink on the cut, paired with a hit. ffmpeg's `fadewhite`
  // is exactly this, and it must stay very short: at anything approaching a
  // dissolve it reads as a mistake rather than an accent.
  if (shot?.transition === "flash") return { name: "fadewhite", d: FLASH_D };
  return { name: "fade", d: HARD_D };
}

/** Source duration, cached per file. */
const durCache = new Map();
async function srcDuration(path) {
  if (!durCache.has(path)) durCache.set(path, await ffprobeDuration(path));
  return durCache.get(path);
}

/** Does this file carry an audio stream? Cached — the same source is reused by every shot. */
const audioCache = new Map();
async function hasAudio(path) {
  if (audioCache.has(path)) return audioCache.get(path);
  const { stdout } = await exec(
    FFPROBE,
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
    {},
  );
  const yes = stdout.trim().length > 0;
  audioCache.set(path, yes);
  return yes;
}

/**
 * Render one shot to a normalized intermediate.
 *
 * A ramped shot is cut into three trims — run-in, slow section, run-out — and
 * concatenated, rather than expressed as one piecewise `setpts` expression.
 * The three-part form is obviously correct and easy to verify; a conditional
 * PTS expression that integrates time is not.
 */
async function renderShot(shot, outDir, name, { padTail = 0, subdir = "", slowmo = "dup" } = {}) {
  const out = subdir ? `${subdir}/${name}.mp4` : `${name}.mp4`;
  const grade = gradeFilter(shot.grade, { lut: shot.lut });
  const fit = buildFitFilter({ fit: shot.fit || "cover", reframe: shot.reframe, outDir, outName: name, aspect: shot.aspect || "9:16" });
  // `fit` may be a multi-node graph (blur splits the stream), so everything
  // downstream is appended as its own chain inside filter_complex.
  // Film grain, laid over everything at low strength. One editor puts a subtle
  // texture layer on "every single video" at around 8% — it is never the thing
  // you notice, but its absence is what makes digital footage look flat and
  // clean in a way sports edits never are.
  const grain = shot.grain ? `noise=alls=${Math.round(shot.grain * 20)}:allf=t+u` : null;
  const post = [fit, grade, grain, `fps=${FPS}`, "format=yuv420p"].filter(Boolean).join(",");

  const args = ["-y"];
  let filter;
  let vLabel;

  // Never ask for source past the end of the file. Running off the end forces
  // `tpad` to clone the last frame, which is a visible freeze mid-play — the
  // planner works from play timestamps and has no idea where the file stops.
  const avail = await srcDuration(shot.src);
  if (shot.srcEnd > avail) {
    const over = shot.srcEnd - avail;
    shot = { ...shot, srcStart: Math.max(0, shot.srcStart - over), srcEnd: avail };
  }

  if (shot.ramp) {
    const { atSrc, slowSrc, speed } = shot.ramp;
    const s0 = shot.srcStart;
    const a0 = 0;
    const a1 = atSrc;
    const b1 = atSrc + slowSrc;
    const total = shot.srcEnd - shot.srcStart + padTail;
    // -ss AND -t must both precede -i. As a trailing option `-t` is consumed by
    // the *next* input (the anullsrc below) instead of trimming the video, so
    // every shot silently ran to the end of the source file.
    args.push("-ss", s0.toFixed(3), "-t", (total + 0.2).toFixed(3), "-i", shot.src);
    // setpts=PTS/speed stretches time: speed 0.5 → twice as long.
    // The run-out is read slightly long and the result trimmed to the exact
    // slot. Trim boundaries don't land on source frame boundaries and the
    // time-stretched middle magnifies the leftover part-frame, so the planned
    // slot — not the arithmetic — is authoritative. Being even a tenth of a
    // second long here pushes every later shot off the beat grid.
    const slot = shot.dur + padTail;
    // Timestamps are rebased to zero BEFORE the trims, and the stream is split
    // explicitly. `-ss` does not guarantee PTS starts at zero — where the seek
    // lands relative to a keyframe can leave source-absolute timestamps on the
    // decoded frames, and then `trim=0.3:0.75` selects the wrong range entirely.
    // Cheap insurance for a failure that would only show on some seek offsets.
    // Framing/grade are applied BEFORE the ramp, not after. A smart-reframe
    // camera path is driven by `sendcmd` at source-relative times; running it
    // downstream of the time-stretch would fire every keyframe at the wrong
    // moment, so the pan would drift out of step with the picture exactly
    // during the slow-motion beat the viewer is looking hardest at.
    filter =
      `[0:v]setpts=PTS-STARTPTS,${post},split=3[b0][b1][b2];` +
      `[b0]trim=${a0.toFixed(3)}:${a1.toFixed(3)},setpts=PTS-STARTPTS[r0];` +
      `[b1]trim=${a1.toFixed(3)}:${b1.toFixed(3)},${slowmoFilter(slowmo, speed)}[r1];` +
      `[b2]trim=${b1.toFixed(3)}:${(total + 0.15).toFixed(3)},setpts=PTS-STARTPTS[r2];` +
      `[r0][r1][r2]concat=n=3:v=1:a=0[rc];` +
      `[rc]trim=0:${slot.toFixed(3)},setpts=PTS-STARTPTS[vout]`;
    vLabel = "[vout]";
  } else {
    // The shot's timeline slot is authoritative: srcEnd-srcStart may exceed it
    // when the B-roll candidate is longer than the beats allocated to it.
    const dur = shot.dur + padTail;
    args.push("-ss", shot.srcStart.toFixed(3), "-t", dur.toFixed(3), "-i", shot.src);
    // `tpad` holds the last frame if the source ran out before the slot was
    // filled (a B-roll candidate near the end of the file, say). Coming up
    // short is worse than a brief freeze: it shifts every later cut off the
    // beat. trim then guarantees the exact slot in both directions.
    filter =
      `[0:v]setpts=PTS-STARTPTS,${post},tpad=stop_mode=clone:stop_duration=${(dur + 0.5).toFixed(3)},` +
      `trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS[vout]`;
    vLabel = "[vout]";
  }

  // Every intermediate carries an audio track of identical format, so the
  // concat demuxer can stream-copy them. Ramped shots get silence instead of
  // their source audio — time-stretched audio pitches and warbles, and the
  // music bed is carrying these moments anyway. Silent game film is the norm
  // here, so whether the source even HAS audio is probed, never assumed: a
  // `0:a?` optional map would silently yield a track-less file that then breaks
  // the concat.
  const silent = !!shot.ramp || shot.mute || !(await hasAudio(shot.src));
  args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-filter_complex", filter);
  args.push("-map", vLabel);
  args.push("-map", silent ? "1:a" : "0:a");
  args.push(
    "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
    "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    out,
  );

  await exec(FFMPEG, args, { cwd: outDir, check: true });
  return join(outDir, out);
}

/**
 * Render an EDL to a finished reel.
 *
 * @param {object} edl        from plan.js
 * @param {string} outDir
 * @param {object} opts       { sfxDir, musicVolume, ambience, name }
 * @returns {Promise<{file:string, duration:number, shots:number}>}
 */
export async function renderReel(edl, outDir, opts = {}) {
  const name = opts.name || "00-hype-reel";
  const musicVol = opts.musicVolume ?? 1.0;
  // A little source ambience keeps the contact, the swish and the sideline
  // alive under the track; the music still carries the edit.
  const ambience = opts.ambience ?? 0.18;
  const sfxVol = opts.sfxVolume ?? 0.55;

  // Any non-hard transition forces the xfade chain (and its tail padding).
  const anyBlend = edl.shots.some((s, i) => i > 0 && s.transition !== "hard");

  // Per-shot intermediates go under .work/ so the output directory holds only
  // what the user actually wants — the reel, the cover and the EDL.
  const workRel = ".work";
  mkdirSync(join(outDir, workRel), { recursive: true });

  // ---------------------------------------------------------------- pass 1
  log.step("Rendering shots");
  const files = [];
  for (let i = 0; i < edl.shots.length; i++) {
    const shot = edl.shots[i];
    // Only the xfade chain needs padding; the concat path must not have any.
    const nextD = anyBlend && i < edl.shots.length - 1 ? transitionSpec(edl.shots[i + 1]).d : 0;
    const base = `shot-${String(i + 1).padStart(2, "0")}`;
    const file = await renderShot(shot, outDir, base, { padTail: nextD, subdir: workRel, slowmo: opts.slowmo || "dup" });
    const measured = await ffprobeDuration(file);
    files.push({ file, base, measured, shot, padTail: nextD });
    log.info(`${base}  ${shot.kind}/${shot.beats}b  planned ${shot.dur.toFixed(2)}s  measured ${measured.toFixed(2)}s${shot.ramp ? "  (ramped)" : ""}`);
  }

  // ---------------------------------------------------------------- pass 2
  log.step("Assembling reel");
  const baseRel = `${workRel}/${name}-base.mp4`;
  const basePath = join(outDir, baseRel);
  if (!anyBlend) {
    // Fast path: hard cuts only → concat demuxer, stream copy.
    const listName = `${workRel}/${name}-concat.txt`;
    writeFileSync(
      join(outDir, listName),
      files.map((f) => `file '${f.file.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
      "utf8",
    );
    await exec(
      FFMPEG,
      ["-y", "-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", baseRel],
      { cwd: outDir, check: true },
    );
  } else {
    // Uniform xfade chain. offset of join i == shots[i].at (see header note).
    const args = ["-y"];
    for (const f of files) args.push("-i", f.file);
    const parts = [];
    let vLab = "[0:v]";
    let aLab = "[0:a]";
    for (let i = 1; i < files.length; i++) {
      const { name: tName, d } = transitionSpec(files[i].shot);
      const off = Math.max(0, files[i].shot.at);
      parts.push(`${vLab}[${i}:v]xfade=transition=${tName}:duration=${d.toFixed(3)}:offset=${off.toFixed(3)}[v${i}]`);
      parts.push(`${aLab}[${i}:a]acrossfade=d=${d.toFixed(3)}[a${i}]`);
      vLab = `[v${i}]`;
      aLab = `[a${i}]`;
    }
    args.push("-filter_complex", parts.join(";"), "-map", vLab, "-map", aLab,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", baseRel);
    await exec(FFMPEG, args, { cwd: outDir, check: true });
  }

  const baseDur = await ffprobeDuration(basePath);

  // ------------------------------------------------------- music + sfx mix
  const lib = opts.sfxDir ? createSfxLibrary(opts.sfxDir) : null;
  const cues = lib
    ? (edl.sfx || [])
        // A hit-to-slow asks for `impact-tail` first — an impact whose decay
        // rings through the slow section — and falls back to a plain impact.
        .map((c, i) => ({
          ...c,
          path: lib.resolve(
            c.tail ? "impact-tail" : c.category,
            c.variant ?? i,
            c.tail ? ["impact"] : [],
          ),
        }))
        .filter((c) => c.path && c.at < baseDur)
    : [];
  const missing = (edl.sfx || []).length - cues.length;
  if (opts.sfxDir && missing > 0) log.info(`${missing} sfx cue(s) skipped (no sample in library)`);

  const args = ["-y", "-i", baseRel];
  const aParts = [];
  const mixLabels = [];

  aParts.push(`[0:a]volume=${ambience}[amb]`);
  mixLabels.push("[amb]");

  let idx = 1;

  // Crowd ambience bed. A continuous room layer under the whole reel, distinct
  // from the one-shot cues: it is the cheapest large improvement in a sports
  // edit — barely noticeable on its own, but the reel sounds thin and airless
  // without it. Looped to cover the picture and mixed well under the music.
  const ambPath = lib?.resolve("ambience", 0);
  if (ambPath) {
    args.push("-stream_loop", "-1", "-i", ambPath);
    aParts.push(
      `[${idx}:a]atrim=0:${baseDur.toFixed(3)},asetpts=N/SR/TB,volume=${opts.ambienceBed ?? 0.22}[bed]`,
    );
    mixLabels.push("[bed]");
    idx++;
    log.info("crowd ambience bed laid under the reel");
  }
  if (edl.music?.path) {
    args.push("-i", edl.music.path);
    // Trim the bed to the finished picture — the reel ends when the material
    // ends, which is usually before the song does.
    aParts.push(
      `[${idx}:a]atrim=${(edl.music.offset || 0).toFixed(3)}:${(
        (edl.music.offset || 0) + baseDur
      ).toFixed(3)},asetpts=N/SR/TB,volume=${musicVol}[mus]`,
    );
    mixLabels.push("[mus]");
    idx++;
  }

  cues.forEach((c, i) => {
    args.push("-i", c.path);
    const ms = Math.max(0, Math.round(c.at * 1000));
    aParts.push(`[${idx}:a]adelay=${ms}|${ms},volume=${sfxVol}[s${i}]`);
    mixLabels.push(`[s${i}]`);
    idx++;
  });

  // duration=first keeps the mix pinned to the picture; normalize=0 stops amix
  // from quietly attenuating everything as inputs are added.
  aParts.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:normalize=0[mixed]`,
  );

  // Render the mix out first so loudness can be measured on the real thing.
  const mixName = `${workRel}/${name}-mix.wav`;
  await exec(
    FFMPEG,
    [...args, "-filter_complex", aParts.join(";"), "-map", "[mixed]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", mixName],
    { cwd: outDir, check: true },
  );

  // -14 LUFS is the streaming/social target. This is deliberately a TWO-pass
  // loudnorm: the one-pass form is only a rough estimate and landed the reel at
  // -16.2 LUFS, over 2 LU quiet against everything else in a feed. Pass one
  // measures, pass two applies those measurements.
  const measured = await measureLoudness(join(outDir, mixName));
  const ln = measured
    ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
      `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:linear=true`
    : `loudnorm=I=-14:TP=-1.5:LRA=11`;

  const outFile = `${name}.mp4`;
  await exec(
    FFMPEG,
    ["-y", "-i", baseRel, "-i", mixName,
      "-af", ln,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart",
      outFile],
    { cwd: outDir, check: true },
  );

  const finalPath = join(outDir, outFile);
  const finalDur = await ffprobeDuration(finalPath);
  log.ok(`reel → ${finalPath} (${finalDur.toFixed(1)}s, ${files.length} shots, ${cues.length} sfx)`);
  return { file: finalPath, duration: finalDur, shots: files.length, sfx: cues.length };
}

/**
 * Pass one of two-pass loudness normalization: measure the mix.
 * Returns null if the JSON can't be read, in which case the caller falls back
 * to single-pass loudnorm rather than failing the render.
 */
async function measureLoudness(path) {
  try {
    const { stderr } = await exec(
      FFMPEG,
      ["-hide_banner", "-i", path, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
      {},
    );
    const a = stderr.lastIndexOf("{");
    const b = stderr.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    const m = JSON.parse(stderr.slice(a, b + 1));
    if (!m.input_i || m.input_i === "-inf") return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Grab the cover frame — "think about that first second as the thumbnail".
 */
export async function exportCover(reelPath, outDir, at = 0, name = "cover.jpg") {
  await exec(
    FFMPEG,
    ["-y", "-ss", Math.max(0, at).toFixed(3), "-i", reelPath, "-frames:v", "1", "-q:v", "2", name],
    { cwd: outDir, check: true },
  );
  return join(outDir, name);
}
