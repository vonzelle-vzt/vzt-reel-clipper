import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, log, FFMPEG, ffprobeDuration } from "../util.js";
import { motionCurve, robustNorm } from "../score.js";
import * as intel from "../intel.js";

/**
 * Measuring a reference edit: where it cuts, and what each shot does.
 *
 * Everything here is deterministic ffmpeg work — no model, no network. The
 * vision pass adds meaning on top (is this a catch or a huddle?), but the
 * skeleton of an edit is geometry and it should be measured as such.
 */

/**
 * Shot boundaries, in seconds.
 *
 * Prefers `vintel scenes` (which already applies a minimum shot length and a
 * sane threshold); falls back to raw ffmpeg scene detection when vintel is not
 * installed, since a style-learner that hard-fails without an optional binary
 * would be useless.
 */
export async function detectCuts(source, { threshold = 0.28 } = {}) {
  const viaIntel = await intel.scenes(source);
  if (viaIntel?.scenes?.length > 1) {
    return viaIntel.scenes.map((s) => +(s.start_ms / 1000).toFixed(3)).filter((t) => t > 0.15);
  }

  const dir = mkdtempSync(join(tmpdir(), "vzt-learn-cuts-"));
  const fname = "cuts.txt";
  try {
    await exec(
      FFMPEG,
      ["-y", "-i", source,
        "-vf", `select='gt(scene\\,${threshold})',metadata=print:file=${fname}`,
        "-an", "-f", "null", "-"],
      { cwd: dir, check: true },
    );
    const txt = readFileSync(join(dir, fname), "utf8");
    return [...txt.matchAll(/pts_time:([\d.]+)/g)].map((m) => +(+m[1]).toFixed(3)).filter((t) => t > 0.15);
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fraction of frames in a range that are near-duplicates of their predecessor.
 *
 * This is the tell for non-interpolated slow motion: halving playback speed on
 * 30fps footage shows every frame twice, so a ramped shot carries a duplicate
 * rate far above a normal one. It is a *heuristic* — footage that is genuinely
 * static also duplicates — so `analyzeShots` requires motion to be present
 * before believing it.
 */
export async function duplicateRate(source, start, end) {
  const dur = Math.max(0.2, end - start);
  const { stderr } = await exec(
    FFMPEG,
    ["-hide_banner", "-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", source,
      "-vf", "mpdecimate=hi=64:lo=32:frac=0.1", "-f", "null", "-"],
    {},
  );
  const kept = [...stderr.matchAll(/frame=\s*(\d+)/g)].map((m) => +m[1]).pop() ?? 0;
  const { stdout } = await exec(
    FFMPEG,
    ["-hide_banner", "-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", source, "-f", "null", "-"],
    {},
  );
  void stdout;
  const total = Math.max(1, Math.round(dur * 30));
  return Math.max(0, Math.min(1, 1 - kept / total));
}

/**
 * Mean saturation and contrast across the video, versus a neutral reference.
 *
 * `signalstats` reports per-frame luma spread and saturation; averaging them
 * gives a coarse fingerprint of the grade. Coarse is the honest word — this
 * distinguishes "punchy and saturated" from "flat and desaturated", and does
 * not attempt to recover a LUT.
 */
export async function gradeStats(source) {
  const { stderr } = await exec(
    FFMPEG,
    ["-hide_banner", "-i", source, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.SATAVG",
      "-an", "-f", "null", "-"],
    {},
  );
  const sats = [...stderr.matchAll(/SATAVG=([\d.]+)/g)].map((m) => +m[1]);
  if (!sats.length) return null;
  const mean = sats.reduce((a, b) => a + b, 0) / sats.length;
  // SATAVG runs 0..~180 in practice; express it against a mid-neutral so the
  // number reads as a multiplier the way the grade presets do.
  return { saturation: +(mean / 60).toFixed(3), samples: sats.length };
}

/**
 * Build the per-shot table a style is derived from.
 *
 * @returns {Promise<Array<{index,start,end,dur,motion,ramped,transition}>>}
 */
export async function analyzeShots(source, { cuts, duration, detectRamps = true } = {}) {
  const dur = duration ?? (await ffprobeDuration(source));
  const bounds = [0, ...cuts.filter((t) => t < dur - 0.2), dur];
  const motion = await motionCurve(source, { fps: 4, roi: [0, 1] });
  const motionN = robustNorm(motion.map((p) => p.v));

  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < 0.2) continue;

    const inShot = motion
      .map((p, k) => ({ t: p.t, v: motionN[k] }))
      .filter((p) => p.t >= start && p.t <= end);
    const meanMotion = inShot.length
      ? +(inShot.reduce((a, p) => a + p.v, 0) / inShot.length).toFixed(3)
      : 0;

    let ramped = false;
    if (detectRamps && end - start >= 0.6) {
      const dupes = await duplicateRate(source, start, end);
      // Duplicates only mean slow motion when something IS moving; a static
      // shot duplicates for the obvious reason and must not be read as a ramp.
      ramped = dupes > 0.25 && meanMotion > 0.35;
    }

    shots.push({
      index: shots.length,
      start: +start.toFixed(3),
      end: +end.toFixed(3),
      dur: +(end - start).toFixed(3),
      motion: meanMotion,
      ramped,
      // Transition typing needs frame-level correlation across the boundary;
      // until that exists every join is recorded as a hard cut rather than
      // guessed at. Reporting an unmeasured mix would be worse than a known gap.
      transition: "hard",
    });
  }
  log.ok(`${shots.length} shots measured`);
  return shots;
}
