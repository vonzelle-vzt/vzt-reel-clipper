import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kleur from "kleur";
import { log, ffprobeDuration } from "./util.js";
import { extractFrames, contactSheet } from "./inspect.js";
import { labelFrames, labelMix, estimateTokens, available as visionAvailable } from "./vision.js";
import { motionCurve, robustNorm } from "./score.js";
import { analyzeMusic } from "./music.js";
import * as intel from "./intel.js";

/**
 * Watch a video: sample its frames, read them in order, analyse its audio, and
 * return one timeline describing what actually happens.
 *
 * Sampled rather than continuous — an event falling entirely between two
 * frames is missed, and `density` is the lever. That limit is stated plainly
 * rather than papered over, because the failure this module exists to prevent
 * was precisely a confident claim about footage nobody had looked at.
 *
 * Vision answers what measurement cannot ("is this a catch or a huddle?");
 * measurement answers what vision cannot from stills ("how fast is this
 * moving, where are the cuts, what is the tempo"). Neither is trusted alone.
 */

/** Sampling rates, frames per second of source. */
export const DENSITIES = { skim: 0.5, normal: 1, detail: 2, forensic: 4 };

export function resolveDensity(d) {
  if (typeof d === "number" && d > 0) return d;
  return DENSITIES[d] ?? DENSITIES.normal;
}

/**
 * @param {string} source  local video path (already resolved from any URL)
 * @param {string} workDir
 * @param {object} opts  { density, sport, mock, sheet, describe }
 */
export async function watchVideo(source, workDir, opts = {}) {
  const density = resolveDensity(opts.density);
  const sport = opts.sport || "sport";
  const duration = await ffprobeDuration(source);
  mkdirSync(workDir, { recursive: true });

  // ------------------------------------------------------------- frames
  log.step("Sampling frames");
  const frameDir = join(workDir, "frames");
  const frames = await extractFrames(source, frameDir, { density });
  const tokens = estimateTokens(frames.length);
  log.ok(`${frames.length} frames at ${density}/s over ${duration.toFixed(1)}s  (~${(tokens / 1000).toFixed(1)}k vision tokens)`);

  // ------------------------------------------------------------- measure
  // Cheap, deterministic, and never skipped — this is the half that does not
  // depend on a model being installed or answering sensibly.
  log.step("Measuring");
  const motion = await motionCurve(source, { fps: Math.max(2, density) });
  const motionN = robustNorm(motion.map((p) => p.v));
  const motionAt = (t) => {
    let best = 0;
    let bestD = Infinity;
    motion.forEach((p, i) => {
      const d = Math.abs(p.t - t);
      if (d < bestD) { bestD = d; best = motionN[i]; }
    });
    return +best.toFixed(3);
  };

  const scenes = await intel.scenes(source);
  const cuts = (scenes?.scenes || []).map((s) => +(s.start_ms / 1000).toFixed(2)).filter((t) => t > 0.2);

  let music = null;
  try {
    music = await analyzeMusic(source);
  } catch {
    log.info("no analysable audio — skipping tempo");
  }

  // ------------------------------------------------------------- watch
  let labelled = frames.map((f) => ({ ...f, label: "unclear", description: "" }));
  let watched = false;
  const canSee = opts.mock ? true : await visionAvailable();
  if (opts.describe !== false && canSee) {
    watched = true;
    log.step("Watching");
    labelled = await labelFrames(frames, { sport, model: opts.model || "haiku", mock: opts.mock });
  } else if (opts.describe !== false) {
    log.warn("vision unavailable — timeline will carry measurement only");
  }

  // ------------------------------------------------------------- fuse
  const timeline = labelled.map((f) => ({
    t: f.t,
    label: f.label,
    description: f.description,
    motion: motionAt(f.t),
    ballVisible: f.ballVisible,
  }));

  const mix = labelMix(labelled);
  const sheetPath = opts.sheet === false ? null : await contactSheet(source, join(workDir, "contact.jpg"));

  const result = {
    source,
    duration: +duration.toFixed(2),
    density,
    frames: frames.length,
    estimatedTokens: tokens,
    watched,
    mix,
    cuts,
    music: music ? { bpm: music.bpm, drop: music.drop, beats: music.beats.length } : null,
    timeline,
    sheet: sheetPath,
  };

  writeFileSync(join(workDir, "watch.json"), JSON.stringify(result, null, 2));
  return result;
}

/** Human-readable summary — what the operator reads before touching a setting. */
export function summarize(w) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [];
  lines.push(kleur.bold(`\n  ${w.duration.toFixed(1)}s · ${w.frames} frames @ ${w.density}/s · ${w.cuts.length} cuts`));
  if (w.music) {
    lines.push(kleur.gray(`  audio: ${w.music.bpm} BPM${w.music.drop != null ? `, drop @ ${w.music.drop.toFixed(1)}s` : ", no clear drop"}`));
  }
  if (w.watched) lines.push(kleur.bold("\n  What's in it:"));
  for (const [label, frac] of w.watched ? Object.entries(w.mix).sort((a, b) => b[1] - a[1]) : []) {
    if (!frac) continue;
    const bar = "█".repeat(Math.round(frac * 30));
    const colour = label === "action" ? kleur.green : label === "unclear" ? kleur.yellow : kleur.gray;
    lines.push(`    ${label.padEnd(12)} ${pct(frac).padStart(4)}  ${colour(bar)}`);
  }

  // The verdict that matters: is this file usable as game film at all?
  //
  // Never state a percentage when nothing was actually looked at. Reporting
  // "0% action" after skipping the vision pass would be the same overconfident
  // claim this module was written to prevent — not-measured is not zero.
  const action = w.mix.action ?? 0;
  lines.push("");
  if (!w.watched) {
    lines.push(kleur.yellow("  ? Content not assessed — the vision pass did not run."));
    lines.push(kleur.gray("    Drop --no-describe (or install the claude CLI) to find out what is in it."));
    return lines.join("\n");
  }
  if (action < 0.1) {
    lines.push(kleur.red().bold(`  ⚠ Only ${pct(action)} of this footage is live action.`));
    lines.push(kleur.red(`    A hype reel cut from it will mostly show players standing around.`));
  } else if (action < 0.3) {
    lines.push(kleur.yellow(`  ⚠ ${pct(action)} live action — usable, but keep the reel short.`));
  } else {
    lines.push(kleur.green(`  ✓ ${pct(action)} live action — enough for a reel.`));
  }
  return lines.join("\n");
}

/** The longest stretches of live action — where a reel should be cut from. */
export function actionSpans(w, { minLen = 1.5 } = {}) {
  const spans = [];
  let cur = null;
  const step = 1 / w.density;
  for (const f of w.timeline) {
    if (f.label === "action") {
      if (!cur) cur = { start: f.t, end: f.t };
      else cur.end = f.t;
    } else if (cur) {
      if (cur.end - cur.start >= minLen) spans.push({ ...cur, end: cur.end + step });
      cur = null;
    }
  }
  if (cur && cur.end - cur.start >= minLen) spans.push({ ...cur, end: cur.end + step });
  return spans;
}
