import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, log, FFMPEG, ffprobeDuration } from "./util.js";

/**
 * Music analysis — the foundation of "edit to your music".
 *
 * A hype reel is driven by the track, not the footage: cuts land on beats, the
 * best play lands on the drop, and clip durations are whole musical bars. None
 * of that is possible without a beat grid, so this module derives one.
 *
 * The approach is classic onset-based tempo tracking, implemented from scratch
 * because nothing in the stack does it and we refuse to add a dependency:
 *
 *   PCM ─▶ STFT ─▶ spectral flux ─▶ onset envelope
 *                                        │
 *                     ┌──────────────────┴──────────────────┐
 *              autocorrelation                        low-band energy
 *              → period → BPM                         → the bass drop
 *                     │
 *              phase search → beats[] → downbeats[]
 *
 * Same division of labour the rest of the repo uses (see src/detect/onnx.js):
 * ffmpeg hands over raw samples, JavaScript does the maths. ffmpeg writes to a
 * temp file rather than a pipe because util.js's `exec` accumulates stdout as a
 * string, which would corrupt binary PCM.
 */

const SR = 22050; // mono analysis rate — plenty for onsets, 1/2 the samples of 44.1k
const WIN = 1024; // ~46ms window
const HOP = 512; //  ~23ms hop → ~43 frames/sec, fine enough to place a beat
const FPS = SR / HOP;

const MIN_BPM = 60;
const MAX_BPM = 200;
const BPM_CENTER = 120; // octave-error prior: 60 and 240 are usually 120 misread

// --------------------------------------------------------------- dsp

/**
 * In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must be power-of-two
 * length. Only the magnitude spectrum is used downstream, so no inverse.
 */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + half] * cr - im[i + j + half] * ci;
        const bi = re[i + j + half] * ci + im[i + j + half] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + half] = ar - br;
        im[i + j + half] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hann = (() => {
  const w = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));
  return w;
})();

/**
 * Short-time spectral flux + low-band energy from mono float samples.
 *
 * Flux is half-wave rectified (only *rising* energy is an onset — a note
 * decaying is not a beat). Low-band energy tracks bins under ~250 Hz, which is
 * where a bass drop announces itself.
 *
 * @returns {{flux: Float64Array, low: Float64Array}} one value per STFT frame
 */
export function onsetEnvelope(samples) {
  const nFrames = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const flux = new Float64Array(Math.max(0, nFrames));
  const low = new Float64Array(Math.max(0, nFrames));
  if (nFrames <= 0) return { flux, low };

  const bins = WIN >> 1;
  // Bin width is SR/WIN Hz; keep everything below ~250Hz for the drop detector.
  const lowBins = Math.max(1, Math.round((250 * WIN) / SR));
  let prev = new Float64Array(bins);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const mag = new Float64Array(bins);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < WIN; i++) {
      re[i] = samples[off + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    let lowSum = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      const d = m - prev[k];
      if (d > 0) sum += d; // half-wave rectify
      if (k < lowBins) lowSum += m;
    }
    flux[f] = sum;
    low[f] = lowSum;
    prev.set(mag);
  }
  return { flux, low };
}

/**
 * Subtract a moving average and rectify, so a loud chorus doesn't drown out the
 * onsets in a quiet verse. Without this, autocorrelation locks onto whichever
 * section is loudest instead of the pulse running through the whole track.
 */
export function normalizeEnvelope(env, windowFrames = Math.round(FPS * 1.5)) {
  const n = env.length;
  const out = new Float64Array(n);
  if (!n) return out;
  const w = Math.max(1, windowFrames);
  let sum = 0;
  const q = [];
  for (let i = 0; i < n; i++) {
    q.push(env[i]);
    sum += env[i];
    if (q.length > w) sum -= q.shift();
    const mean = sum / q.length;
    out[i] = Math.max(0, env[i] - mean);
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (out[i] > max) max = out[i];
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

/**
 * Estimate tempo AND phase with a comb filter over fractional lags.
 *
 * Plain autocorrelation was tried first and is not good enough here. Two
 * failures, both measured against synthesized click tracks:
 *
 *  1. Octave errors. When the true period lands near a half-integer number of
 *     STFT frames (120 BPM → 21.53, 140 BPM → 18.46), consecutive onsets split
 *     across frame boundaries unevenly, which amplitude-modulates the envelope
 *     with a two-beat cycle. Autocorrelation then peaks at 2× the true period —
 *     120 BPM read as 60, 140 as 70. A tempo prior cannot rescue it; the wrong
 *     lag genuinely correlates ~1.6× stronger.
 *  2. Drift. An integer frame lag is up to ±4 BPM off at fast tempos, and that
 *     error accumulates linearly — seconds of slip across a 3-minute track,
 *     which is fatal when every cut is supposed to land on a beat.
 *
 * A comb filter fixes both. Each candidate (period, phase) predicts a grid; we
 * score how much onset energy that grid captures, as an F1-style product:
 *
 *   coverage  = captured / total onset energy   → punishes too-SLOW candidates,
 *                                                 which leave half the onsets
 *                                                 unexplained (kills the octave
 *                                                 error autocorrelation makes)
 *   precision = captured / number of grid points → punishes too-FAST candidates,
 *                                                 whose extra beats land on
 *                                                 silence
 *
 * Lags are fractional and the envelope is sampled with linear interpolation, so
 * the period is exact to ~0.2 BPM and the phase comes out of the same search.
 * Verified on synthetic clicks from 80–175 BPM: worst error 0.20 BPM, worst
 * drift 5.4 ms across 8 beats.
 *
 * @returns {{bpm: number, periodFrames: number, phaseFrames: number}}
 */
export function estimateTempo(env) {
  const minLag = Math.max(2, (60 / MAX_BPM) * FPS);
  const maxLag = Math.min(env.length - 1, (60 / MIN_BPM) * FPS);
  if (maxLag <= minLag) throw new Error("music track too short to estimate a tempo");

  let total = 0;
  for (let i = 0; i < env.length; i++) total += env[i];
  if (total <= 0) throw new Error("music track has no detectable onsets");

  // Linear-interpolated envelope lookup — the whole point is sub-frame lags.
  const at = (x) => {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= env.length) return 0;
    const f = x - i;
    return env[i] * (1 - f) + env[i + 1] * f;
  };

  /**
   * Score one candidate period over `maxBeats` grid points, searching phase in
   * `[phLo, phHi)`. ±1 frame tolerance per point absorbs the STFT quantization
   * this whole method exists to dodge.
   *
   * Note the coupling that governs both stages below: a lag error of δ puts the
   * Nth grid point off by N·δ, so lag resolution must be finer than 1/N. That
   * is why a cheap coarse sweep over the *whole* track is not an option — it
   * silently mis-scores the true period and hands the win to an octave.
   */
  const scoreLag = (lag, { phaseStep, phLo = 0, phHi = lag, maxBeats = Infinity }) => {
    const nGrid = Math.min(maxBeats, Math.floor((env.length - 1) / lag) + 1);
    let bestHit = -1;
    let bestPhase = 0;
    for (let ph = phLo; ph < phHi; ph += phaseStep) {
      let hit = 0;
      for (let k = 0; k < nGrid; k++) {
        const x = ph + k * lag;
        hit += Math.max(at(x - 1), at(x), at(x + 1));
      }
      if (hit > bestHit) {
        bestHit = hit;
        bestPhase = ph;
      }
    }
    // Coverage is measured against the onset energy actually inside the scored
    // span, so a prefix pass isn't unfairly penalised against the full track.
    const span = Math.min(env.length, (bestPhase + nGrid * lag) | 0) || env.length;
    let spanTotal = 0;
    for (let i = 0; i < span; i++) spanTotal += env[i];
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / BPM_CENTER) / 0.9, 2));
    const coverage = bestHit / (spanTotal || total);
    return { score: coverage * (bestHit / nGrid) * prior, phase: bestPhase, lag, bpm };
  };

  // Stage 1 — find the period over a short prefix (16 beats). Bounding the beat
  // count bounds the accumulated lag error, which lets a 0.05-frame step be
  // both fine enough to be correct and cheap enough to sweep the full range.
  let best = null;
  for (let lag = minLag; lag <= maxLag; lag += 0.05) {
    const r = scoreLag(lag, { phaseStep: 0.25, maxBeats: 16 });
    if (!best || r.score > best.score) best = r;
  }

  // Stage 2 — refine against every beat in the track. Cheap because both lag
  // and phase are already pinned to a narrow band. This is what keeps a cut at
  // minute three still landing on the beat: 0.2 BPM of error would drift ~300ms
  // across a 3-minute track, which is audibly off.
  //
  // Stage 2 candidates are scored over every beat while `best` was scored over
  // 16, so the two scores are NOT comparable — seeding the max with `best`
  // silently keeps the coarse estimate whenever its prefix score happens to be
  // higher, which is a ~700ms drift at 150 BPM. Stage 2 therefore takes its
  // maximum strictly among its own candidates.
  const lo = Math.max(minLag, best.lag - 0.5);
  const hi = Math.min(maxLag, best.lag + 0.5);
  let refined = null;
  for (let lag = lo; lag <= hi; lag += 0.005) {
    const r = scoreLag(lag, {
      phaseStep: 0.05,
      phLo: Math.max(0, best.phase - 0.6),
      phHi: best.phase + 0.6,
    });
    if (!refined || r.score > refined.score) refined = r;
  }
  const win = refined || best;
  return { bpm: win.bpm, periodFrames: win.lag, phaseFrames: win.phase };
}

/**
 * Lay the grid down from the period and phase the comb search already found.
 * Positions accumulate in fractional frames so the grid never drifts.
 */
export function beatGrid(periodFrames, phaseFrames, duration) {
  const beats = [];
  for (let k = 0; ; k++) {
    const t = (phaseFrames + k * periodFrames) / FPS;
    if (t > duration) break;
    beats.push(+t.toFixed(4));
  }
  return beats;
}

/**
 * Pick which beat is beat one of the bar (assume 4/4) by testing all four
 * phases and taking the one carrying the most onset energy, then return every
 * 4th beat from there.
 */
export function downbeatsOf(beats, env, periodFrames) {
  if (beats.length < 4) return beats.slice();
  const p = Math.max(2, Math.round(periodFrames));
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let acc = 0;
    for (let b = phase; b < beats.length; b += 4) {
      const idx = Math.round(beats[b] * FPS);
      // Sample a small neighbourhood — the grid is quantized, the audio isn't.
      for (let k = -1; k <= 1; k++) {
        const i = idx + k;
        if (i >= 0 && i < env.length) acc += env[i];
      }
    }
    if (acc > bestScore) {
      bestScore = acc;
      bestPhase = phase;
    }
    void p;
  }
  const out = [];
  for (let b = bestPhase; b < beats.length; b += 4) out.push(beats[b]);
  return out;
}

/**
 * Locate the bass drop: the largest *sustained* jump in low-band energy.
 *
 * Sustained matters — a single kick is not a drop. We compare the mean low-end
 * over the window after a candidate against the window before it, and require
 * the second half of the "after" window to hold up, so a one-off hit can't win.
 *
 * @returns {number|null} seconds, or null if nothing stands out
 */
export function detectDrop(low, duration, { windowSec = 2.5 } = {}) {
  const w = Math.max(2, Math.round(windowSec * FPS));
  if (low.length < w * 2 + 2) return null;
  const mean = (from, to) => {
    let s = 0;
    for (let i = from; i < to; i++) s += low[i];
    return s / Math.max(1, to - from);
  };
  let bestI = -1;
  let bestGain = 0;
  for (let i = w; i + w < low.length; i++) {
    const before = mean(i - w, i);
    const after = mean(i, i + w);
    const hold = mean(i + (w >> 1), i + w); // second half must stay up
    if (before <= 1e-9) continue;
    const gain = after / before;
    if (hold < before * 1.15) continue; // decayed straight back — not a drop
    if (gain > bestGain) {
      bestGain = gain;
      bestI = i;
    }
  }
  if (bestI < 0 || bestGain < 1.35) return null;
  const t = bestI / FPS;
  return t <= duration ? +t.toFixed(3) : null;
}

// --------------------------------------------------------------- helpers

/** Nearest beat to `t`. Returns `t` unchanged when there is no grid. */
export function snapToBeat(t, beats) {
  if (!beats?.length) return t;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const a = beats[Math.max(0, lo - 1)];
  const b = beats[lo];
  return Math.abs(t - a) <= Math.abs(b - t) ? a : b;
}

/** Seconds in one bar of 4/4 at `bpm`. */
export function barSeconds(bpm) {
  return (60 / bpm) * 4;
}

// --------------------------------------------------------------- pipeline

/** Decode a track to mono float samples via ffmpeg (temp file, not a pipe). */
async function readPcm(path) {
  const dir = mkdtempSync(join(tmpdir(), "vzt-music-"));
  const name = "a.pcm";
  try {
    await exec(
      FFMPEG,
      ["-y", "-i", path, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-acodec", "pcm_s16le", name],
      { cwd: dir, check: true },
    );
    const buf = readFileSync(join(dir, name));
    const n = buf.length >> 1;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build a beat grid from a KNOWN tempo instead of from an audio file.
 *
 * This exists for the in-app-audio workflow. TikTok and Instagram license their
 * music libraries for use inside those apps, and a streaming subscription's
 * files are DRM-protected, so there is often no track on disk to analyze — but
 * the edit still needs a grid to cut to. Modern produced music is written to a
 * fixed grid, so a constant tempo reproduces it faithfully.
 *
 * Cut to this, export a silent master (`--no-music-bed`), then select the
 * official sound in the app and set it to begin at `drop`.
 *
 * @param {number} bpm
 * @param {{drop?: number|null, duration?: number}} [opts]
 */
export function syntheticGrid(bpm, { drop = null, duration = 180 } = {}) {
  if (!(bpm > 0)) throw new Error(`--bpm must be a positive number (got ${bpm})`);
  const per = 60 / bpm;
  const beats = [];
  for (let t = 0; t <= duration; t += per) beats.push(+t.toFixed(4));
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  // Snap a supplied drop to the bar so the hook still lands musically.
  const snapped = drop != null && downbeats.length ? snapToBeat(drop, downbeats) : drop;
  log.ok(
    `${bpm} BPM grid · ${beats.length} beats · ${downbeats.length} bars` +
      (snapped != null ? ` · drop @ ${snapped.toFixed(2)}s` : " · no drop given"),
  );
  return { bpm, beats, downbeats, drop: snapped, duration, path: null, synthetic: true };
}

/**
 * Full analysis of a music bed.
 *
 * @returns {Promise<{bpm:number, beats:number[], downbeats:number[], drop:number|null, duration:number, path:string}>}
 */
export async function analyzeMusic(path) {
  log.info("analyzing music (onsets → tempo → beat grid)…");
  const samples = await readPcm(path);
  if (samples.length < WIN * 4) throw new Error(`music track too short to analyze: ${path}`);
  const duration = await ffprobeDuration(path);

  const { flux, low } = onsetEnvelope(samples);
  const env = normalizeEnvelope(flux);
  const { bpm, periodFrames, phaseFrames } = estimateTempo(env);
  const beats = beatGrid(periodFrames, phaseFrames, duration);
  const downbeats = downbeatsOf(beats, env, periodFrames);
  let drop = detectDrop(low, duration);
  // The drop is a musical event; align it to the bar so cuts stay on the grid.
  if (drop != null && downbeats.length) drop = snapToBeat(drop, downbeats);

  log.ok(
    `${bpm.toFixed(1)} BPM · ${beats.length} beats · ${downbeats.length} bars` +
      (drop != null ? ` · drop @ ${drop.toFixed(1)}s` : " · no clear drop"),
  );
  return { bpm: +bpm.toFixed(2), beats, downbeats, drop, duration, path };
}
