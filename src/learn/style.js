import { ARCS, arcEnergy } from "../plan.js";

/**
 * Turning a reference edit into numbers.
 *
 * "Make it like that one" is the most common note an editor gets, and until now
 * it was unanswerable here — the doctrine was hardcoded and the only way to
 * chase a reference was to guess at flags. But an edit's *grammar* is
 * measurable: how often it cuts relative to the beat, how shot lengths rise and
 * fall, how often it ramps, how much of it is action versus everything else.
 * Those are the same knobs `planEdit` already exposes.
 *
 * This module is deliberately PURE. Measurements in, style profile out, no
 * ffmpeg and no network, so every derived number is asserted in tests without
 * downloading a thing. All the I/O lives in ./shots.js and ./index.js.
 *
 * What is NOT claimed: this recovers the *grammar*, not the taste. It cannot
 * tell you why a shot was chosen, only how long it was held and what it was
 * cut against.
 */

/** Style schema version — bump when the shape changes so stale files are caught. */
export const STYLE_VERSION = 1;

function percentileOf(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * How closely the cuts land on the beat.
 *
 * This is the single most diagnostic number about a music-driven edit: a reel
 * cut by hand to a track sits in the 80-95% band, while an edit assembled
 * without reference to the music scores near chance. Chance is not zero —
 * with a tolerance window of ±tol against a beat every `period` seconds, a
 * random cut lands "on beat" 2·tol/period of the time — so the raw percentage
 * is reported alongside how much it beats chance by.
 */
export function beatAlignment(cuts, beats, { tol = 0.06 } = {}) {
  if (!cuts.length || beats.length < 2) return { onBeatPct: 0, chance: 0, lift: 0 };
  let hits = 0;
  for (const c of cuts) {
    const nearest = beats.reduce((best, b) => (Math.abs(b - c) < Math.abs(best - c) ? b : best), beats[0]);
    if (Math.abs(nearest - c) <= tol) hits++;
  }
  const period = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
  const chance = Math.min(1, (2 * tol) / period);
  const onBeatPct = hits / cuts.length;
  return {
    onBeatPct: +onBeatPct.toFixed(3),
    chance: +chance.toFixed(3),
    lift: +(onBeatPct - chance).toFixed(3),
  };
}

/**
 * Which built-in arc the reference's shot-length sequence most resembles.
 *
 * Shot lengths are inverted into "energy" (short shot = high energy) and
 * normalized, then compared against each candidate arc sampled at the same
 * positions. Correlation rather than absolute error, because a reference may
 * simply run faster or slower than ours overall while having the same *shape*
 * — and shape is the thing worth copying.
 */
/** Below this correlation the winning arc is not meaningfully better than noise. */
export const ARC_CONFIDENCE = 0.4;

export function fitArc(shotDurations) {
  if (shotDurations.length < 4) return { arc: "steady", fit: 0, confident: false };
  const max = Math.max(...shotDurations);
  const min = Math.min(...shotDurations);
  const span = max - min || 1;
  // Invert: the shortest shot is peak energy.
  const observed = shotDurations.map((d) => 1 - (d - min) / span);

  let best = { arc: "steady", fit: -Infinity };
  for (const name of Object.keys(ARCS)) {
    const expected = observed.map((_, i) => arcEnergy(name, i / Math.max(1, observed.length - 1)));
    const fit = correlation(observed, expected);
    if (fit > best.fit) best = { arc: name, fit: +fit.toFixed(3) };
  }

  // A weak winner is still a winner among the candidates, but that does NOT
  // mean the reference has that shape — with few shots the best correlation is
  // often near chance. Measured on a known-rollercoaster reel it picked "build"
  // at 0.185, which is noise wearing a label. Report the number, mark it
  // unconfident, and fall back to the neutral arc so a bad read cannot quietly
  // reshape someone's edit.
  const confident = best.fit >= ARC_CONFIDENCE;
  return { arc: confident ? best.arc : "steady", fit: best.fit, confident, bestGuess: best.arc };
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * Derive a style profile.
 *
 * @param {object} m measurements
 * @param {Array<{start,end,dur,ramped,transition,label}>} m.shots
 * @param {number[]} m.beats
 * @param {number} m.bpm
 * @param {number} m.duration
 * @param {object} [m.grade]   { saturation, contrast }
 * @param {string} [name]
 */
export function deriveStyle(m, name = "reference") {
  const shots = m.shots || [];
  const durs = shots.map((s) => s.dur).filter((d) => d > 0);
  const sorted = [...durs].sort((a, b) => a - b);
  const beatSec = m.bpm > 0 ? 60 / m.bpm : null;

  const cuts = shots.map((s) => s.start).filter((t) => t > 0.2);
  const align = beatAlignment(cuts, m.beats || []);
  const arc = fitArc(durs);

  // Shot lengths in BEATS, which is the unit planEdit allocates in. Without a
  // tempo there is nothing to express them against, so they stay null rather
  // than being silently reported in seconds under a beats-shaped key.
  const inBeats = (sec) => (beatSec ? Math.max(1, Math.round(sec / beatSec)) : null);

  const labelled = shots.filter((s) => s.label);
  const actionPct = labelled.length
    ? +(labelled.filter((s) => s.label === "action").length / labelled.length).toFixed(3)
    : null;

  const ramped = shots.filter((s) => s.ramped).length;
  const transitions = { hard: 0, xfade: 0, whip: 0 };
  for (const s of shots) {
    if (s.transition && transitions[s.transition] != null) transitions[s.transition]++;
  }
  const tTotal = Math.max(1, Object.values(transitions).reduce((a, b) => a + b, 0));
  for (const k of Object.keys(transitions)) transitions[k] = +(transitions[k] / tTotal).toFixed(3);

  return {
    version: STYLE_VERSION,
    name,
    source: m.source ?? null,
    music: {
      bpm: m.bpm ?? null,
      onBeatPct: align.onBeatPct,
      chance: align.chance,
      lift: align.lift,
      cutsPerBar: beatSec && m.duration ? +((cuts.length / (m.duration / (beatSec * 4)))).toFixed(2) : null,
    },
    pacing: {
      shotSec: {
        p10: +percentileOf(sorted, 0.1).toFixed(2),
        p50: +percentileOf(sorted, 0.5).toFixed(2),
        p90: +percentileOf(sorted, 0.9).toFixed(2),
      },
      beats: {
        min: inBeats(percentileOf(sorted, 0.1)),
        median: inBeats(percentileOf(sorted, 0.5)),
        max: inBeats(percentileOf(sorted, 0.9)),
      },
      arc: arc.arc,
      arcFit: arc.fit,
      arcConfident: arc.confident,
      arcBestGuess: arc.bestGuess ?? arc.arc,
      shots: shots.length,
    },
    composition: { actionPct },
    effects: {
      rampPct: shots.length ? +(ramped / shots.length).toFixed(3) : 0,
      transitions,
    },
    grade: m.grade ?? null,
  };
}

/**
 * Map a style profile onto the options `planEdit` already accepts.
 *
 * `explicit` always wins: a flag the user typed must never be silently
 * overridden by a learned profile. The returned `provenance` records where each
 * value came from so the run can print it — an unexplained override would be
 * the same class of problem as reporting a figure that was never measured.
 */
export function styleToPlanOpts(style, explicit = {}) {
  const opts = {};
  const provenance = {};
  const take = (key, value) => {
    if (value == null) return;
    if (explicit[key] != null) {
      opts[key] = explicit[key];
      provenance[key] = "flag";
    } else {
      opts[key] = value;
      provenance[key] = "style";
    }
  };

  take("arc", style?.pacing?.arc);
  take("minShotBeats", style?.pacing?.beats?.min);
  take("grade", style?.grade?.preset);
  // rampCount is a COUNT in the planner but a FRACTION in the style, so it can
  // only be resolved once the number of plays is known — see resolveRampCount.
  if (style?.effects?.rampPct != null && explicit.rampCount == null) {
    provenance.rampCount = "style";
  } else if (explicit.rampCount != null) {
    opts.rampCount = explicit.rampCount;
    provenance.rampCount = "flag";
  }

  // Carry through anything the caller set that the style has no opinion on.
  for (const [k, v] of Object.entries(explicit)) {
    if (v != null && opts[k] == null) {
      opts[k] = v;
      provenance[k] = "flag";
    }
  }
  return { opts, provenance };
}

/** Ramp fraction → an actual count, once the play count is known. */
export function resolveRampCount(style, playCount, explicit) {
  if (explicit != null) return explicit;
  const pct = style?.effects?.rampPct;
  if (pct == null) return undefined;
  return Math.max(1, Math.round(playCount * pct));
}
