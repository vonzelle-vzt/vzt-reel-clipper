import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log, ffprobeDuration } from "../util.js";
import { resolveInput } from "../resolve.js";
import { analyzeMusic } from "../music.js";
import { contactSheet, extractFrames } from "../inspect.js";
import { labelFrames, available as visionAvailable } from "../vision.js";
import { detectCuts, analyzeShots, gradeStats } from "./shots.js";
import { deriveStyle } from "./style.js";

/**
 * Learn an editing style from a reference reel.
 *
 * Point it at a video someone already cut well and it recovers the grammar:
 * tempo, how tightly the cuts track the beat, how shot lengths rise and fall,
 * how often it ramps, how much of it is action. Those become a named profile
 * the planner reads, so "cut it like that one" stops being a guess.
 *
 * The downloaded video is DELETED once measured. What is kept is a set of
 * numbers describing an approach and one small contact sheet — the measurements
 * are ours, the footage is not.
 */

const STYLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "styles");

export function stylesDir() {
  return STYLES_DIR;
}

/** Load a named style, or a path to one. */
export function loadStyle(nameOrPath) {
  const candidates = [
    nameOrPath,
    join(STYLES_DIR, `${nameOrPath}.json`),
    join(process.cwd(), "styles", `${nameOrPath}.json`),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(
    `style "${nameOrPath}" not found. Learn one first:\n  reelclip learn <url> --name ${nameOrPath}`,
  );
}

/** Names of the styles currently available. */
export function listStyles() {
  if (!existsSync(STYLES_DIR)) return [];
  return readdirSync(STYLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/**
 * @param {string} input  URL or local path to the reference edit
 * @param {object} opts   { name, workDir, sport, describe, keepVideo, density }
 */
export async function learnStyle(input, opts = {}) {
  const name = opts.name || "reference";
  const workDir = opts.workDir || join(process.cwd(), ".learn");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(STYLES_DIR, { recursive: true });

  // ------------------------------------------------------------- fetch
  log.step("Fetching reference");
  const { videoPath, title } = await resolveInput(input, workDir, {
    cookiesFile: opts.cookies,
    cookiesFromBrowser: opts.cookiesFromBrowser,
    proxy: opts.proxy,
  });
  const duration = await ffprobeDuration(videoPath);
  log.ok(`${title || "reference"} — ${duration.toFixed(1)}s`);

  // ------------------------------------------------------------- measure
  log.step("Finding cuts");
  const cuts = await detectCuts(videoPath);
  log.ok(`${cuts.length} cuts`);

  log.step("Measuring shots");
  const shots = await analyzeShots(videoPath, { cuts, duration });

  log.step("Analyzing the track");
  let music = null;
  try {
    music = await analyzeMusic(videoPath);
  } catch {
    log.warn("no analysable audio — pacing will be reported in seconds, not beats");
  }

  const grade = await gradeStats(videoPath).catch(() => null);

  // ------------------------------------------------------------- classify
  // One frame at the middle of each shot is enough to say what KIND of shot it
  // is, and costs a fraction of watching the whole reference.
  if (opts.describe !== false && (opts.mock || (await visionAvailable())) && shots.length) {
    log.step("Watching the reference");
    const frameDir = join(workDir, "shot-frames");
    const frames = await extractFrames(videoPath, frameDir, { density: 1 });
    const picks = shots
      .map((s) => {
        const mid = (s.start + s.end) / 2;
        const f = frames.reduce((best, x) => (Math.abs(x.t - mid) < Math.abs(best.t - mid) ? x : best), frames[0]);
        return f ? { ...f, shot: s.index } : null;
      })
      .filter(Boolean);
    const labelled = await labelFrames(picks, { sport: opts.sport || "sport", mock: opts.mock });
    for (const l of labelled) {
      const s = shots.find((x) => x.index === l.shot);
      if (s) s.label = l.label;
    }
  }

  // ------------------------------------------------------------- derive
  const style = deriveStyle(
    {
      shots,
      beats: music?.beats || [],
      bpm: music?.bpm ?? null,
      duration,
      grade,
      source: typeof input === "string" ? input : null,
    },
    name,
  );

  const stylePath = join(STYLES_DIR, `${name}.json`);
  writeFileSync(stylePath, JSON.stringify(style, null, 2));
  const sheet = await contactSheet(videoPath, join(STYLES_DIR, `${name}.jpg`), { tiles: 24 });

  // ------------------------------------------------------------- cleanup
  // Keep the numbers, not the footage.
  if (!opts.keepVideo && videoPath.startsWith(workDir)) {
    try {
      rmSync(videoPath, { force: true });
      log.info("reference video deleted — style numbers and sheet kept");
    } catch { /* best effort */ }
  }

  return { style, stylePath, sheet };
}

/** One-screen summary of what was learned. */
export function describeStyle(s) {
  const L = [];
  L.push(`\n  ${s.name}  (${s.pacing.shots} shots)`);
  if (s.music.bpm) {
    const lift = s.music.lift;
    const verdict = lift > 0.35 ? "cut to the music" : lift > 0.15 ? "loosely on the beat" : "not beat-driven";
    L.push(`  music    ${s.music.bpm} BPM · ${Math.round(s.music.onBeatPct * 100)}% of cuts on-beat ` +
           `(chance ${Math.round(s.music.chance * 100)}%) → ${verdict}`);
    if (s.music.cutsPerBar) L.push(`           ${s.music.cutsPerBar} cuts per bar`);
  } else {
    L.push("  music    no analysable audio");
  }
  L.push(`  pacing   shots ${s.pacing.shotSec.p10}s → ${s.pacing.shotSec.p50}s → ${s.pacing.shotSec.p90}s` +
         (s.pacing.beats.median ? `  (${s.pacing.beats.min}-${s.pacing.beats.max} beats)` : ""));
  L.push(s.pacing.arcConfident === false
    ? `           arc  no clear shape (best guess "${s.pacing.arcBestGuess}" at ${s.pacing.arcFit}) → using "steady"`
    : `           arc "${s.pacing.arc}" (fit ${s.pacing.arcFit})`);
  if (s.composition.actionPct != null) {
    L.push(`  content  ${Math.round(s.composition.actionPct * 100)}% action`);
  }
  L.push(`  effects  ${Math.round(s.effects.rampPct * 100)}% of shots ramped`);
  if (s.grade?.saturation) L.push(`  grade    saturation ${s.grade.saturation}`);
  return L.join("\n");
}
