import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, log, FFMPEG, ffprobeDuration } from "./util.js";
import { loudnessCurve } from "./sports.js";
import { getProfile } from "./profiles.js";
import * as intel from "./intel.js";

/**
 * Multi-signal play scoring.
 *
 * The original sports mode ranked plays by audio energy alone (ebur128 peaks:
 * crowd roar, contact, whistles). That works on broadcast-ish footage with a
 * crowd mic and fails completely on the footage this tool actually gets.
 * NextPlay hit this in production and wrote it down in
 * `src/lib/highlights/dead-ball.ts`:
 *
 *   "Parent-shot phone film has no crowd mic, so every event scores a neutral
 *    0.5 and the audio rescue never fires."
 *
 * A silent sideline recording has no peaks to find, so audio-only selection
 * returns noise. Worse, when there IS crowd audio the loudest moments are often
 * the *dead* ones — the whistle, the reaction after the whistle, the crowd
 * still roaring while everyone stands around.
 *
 * So three signals are combined, weighted after NextPlay's validated split:
 *
 *   motion  0.40  frame-to-frame change — works with the audio muted
 *   audio   0.25  reused ebur128 loudness (sports.js)
 *   context 0.35  CLIP semantic hits for THIS sport + scene density (vintel)
 *
 * Any signal can be missing. When one is, its weight is redistributed across
 * the survivors rather than silently dragging every score down — that is what
 * keeps a silent, vintel-less run working on motion alone.
 *
 * The sport is never hardcoded: query vocabulary, play window and stoppage
 * language all come from `src/profiles.js`.
 */

// `burst` carries the weight that `context` cannot when semantic search is
// unavailable or degenerate — it is what separates a play from milling.
export const WEIGHTS = { motion: 0.3, burst: 0.25, audio: 0.2, context: 0.25 };

// Motion sampling. Deliberately tiny — we want "did a lot change", not detail,
// and a 90-minute game at a bigger grid would be hundreds of MB of raw frames.
const MOTION_FPS = 2;
const GRID_W = 64;
const GRID_H = 36;

// Half-width (seconds) of the window used to measure a play's travel direction.
// Roughly the span of footage that survives into a shot once the planner has
// centred it on the peak.
const SHOT_DIR_WINDOW = 1.5;

/**
 * Vertical band of the frame that motion is measured in, as [top, bottom]
 * fractions.
 *
 * Sport shot from the stands puts the near sideline across the BOTTOM of frame
 * and the crowd/stands across the top. Those foreground bodies are enormous in
 * pixel terms — a substitute shifting his weight two metres from the lens moves
 * far more pixels than a receiver running a fifty-yard route, so whole-frame
 * motion tracks the sideline and reports players standing around as the biggest
 * "play" in the video. Measured on real film: the top-scored moments were
 * players standing with their hands on their hips.
 *
 * Restricting measurement to the middle band puts the field back in charge.
 */
const DEFAULT_ROI = [0.12, 0.78];

// Seconds of runway kept before the detected start of a play, so the clip opens
// on the set-up rather than mid-action.
const LEAD_IN = 1.0;

// --------------------------------------------------------------- pure maths

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Scale a series to roughly 0..1 using median/MAD rather than min/max, so one
 * freak spike (a camera bump, a slammed door) can't flatten everything else.
 */
export function robustNorm(values) {
  if (!values.length) return [];
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med))) || 1;
  return values.map((v) => {
    const z = (v - med) / (1.4826 * mad);
    return Math.max(0, Math.min(1, 0.5 + z / 6)); // ~±3σ mapped into [0,1]
  });
}

/**
 * Blend the available signals. `signals` values may be null/undefined for a
 * signal that could not be measured; those weights are redistributed.
 *
 * @param {{motion?:number|null, audio?:number|null, context?:number|null}} signals
 * @param {object} [weights]
 * @returns {number} 0..1
 */
export function combine(signals, weights = WEIGHTS) {
  let sum = 0;
  let wTotal = 0;
  for (const k of Object.keys(weights)) {
    const v = signals[k];
    if (v == null || Number.isNaN(v)) continue;
    sum += weights[k] * v;
    wTotal += weights[k];
  }
  if (wTotal <= 0) return 0;
  return sum / wTotal; // renormalize so a missing signal doesn't deflate scores
}

/**
 * Dead-ball detection over a written description of the moment (available only
 * when `vintel observe` produced captions).
 *
 * Ported from nextplay/src/lib/highlights/dead-ball.ts, including the bug it
 * documents: an earlier version matched `referee|whistle|stoppage|…` ANYWHERE
 * in the text and threw away real plays whose description merely mentioned an
 * official. Verified against production, 3 of 9 excluded events were live —
 * "Fast-break transition … referee signaling" among them. Match an explicit
 * ASSERTION that the segment is dead, never a passing mention.
 */
export function isDeadBallDescription(description, terms, audioScore) {
  const desc = String(description ?? "");
  if (!desc) return false;
  // A genuinely loud moment is something happening; keep it regardless.
  if (typeof audioScore === "number" && audioScore >= 0.6) return false;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i").test(desc);
}

/**
 * Signal-only dead-ball heuristic, for the (normal) case where there is no
 * description to read.
 *
 * The tell is loud-but-still: the whistle blew, the crowd is reacting, and
 * nobody is moving. That is exactly the moment audio-only selection loves and
 * a viewer skips. Note the asymmetry — quiet-and-still is NOT rejected here,
 * because it scores low on its own and rejecting it would also throw away
 * silent phone-film action.
 */
export function looksDeadBall({ motion, audio }, { motionFloor = 0.3, audioCeil = 0.6 } = {}) {
  if (motion == null || audio == null) return false;
  // Bounds are INCLUSIVE. A static stretch of footage produces a plateau of
  // identical motion values, so the percentile threshold lands exactly ON that
  // plateau — with a strict `<` the entire dead stretch sits one float above
  // the cutoff and none of it is ever rejected. Measured: motion 0.388 against
  // a 0.38758 floor.
  return motion <= motionFloor && audio >= audioCeil;
}

/** Value at a fractional rank (0..1) of a series. */
export function percentile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.max(0, Math.min(s.length - 1, Math.round(q * (s.length - 1))));
  return s[i];
}

/**
 * Derive dead-ball thresholds from THIS video's own distribution.
 *
 * Fixed cutoffs don't survive `robustNorm`, which maps to roughly [0,1] but
 * does not actually reach the ends: on real footage the quiet half of a clip
 * still measured 0.388 motion, so a 0.3 floor never fired and every dead-ball
 * moment sailed through. Ranking within the video is scale-free and says what
 * we actually mean — "still for this footage, loud for this footage".
 */
export function deadBallThresholds(motionVals, audioVals) {
  return {
    motionFloor: percentile(motionVals, 0.35),
    audioCeil: percentile(audioVals, 0.65),
  };
}

/**
 * Walk back from a scored peak to where the burst that caused it began — the
 * snap, not the tackle. Bounded by `maxBack` so a long quiet stretch can't drag
 * the window to the start of the video.
 */
export function burstOnsetBefore(burst, t, maxBack) {
  const from = t - maxBack;
  let best = t;
  let bestV = -1;
  for (const p of burst) {
    if (p.t < from || p.t > t) continue;
    if (p.v > bestV) { bestV = p.v; best = p.t; }
  }
  return best;
}

/** Time of maximum value within [start, end] — the moment of impact. */
export function busiestIn(series, start, end) {
  let best = null;
  let bestV = -Infinity;
  for (const p of series) {
    if (p.t < start || p.t > end) continue;
    if (p.v > bestV) { bestV = p.v; best = p.t; }
  }
  return best;
}

/** Sample a time-indexed series at time `t` (nearest neighbour). */
export function sampleAt(series, t) {
  if (!series?.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const a = series[Math.max(0, lo - 1)];
  const b = series[lo];
  return Math.abs(t - a.t) <= Math.abs(b.t - t) ? a.v : b.v;
}

/**
 * Greedy non-maximum suppression: keep the highest-scoring candidates that are
 * at least `minGap` seconds apart.
 */
export function suppress(candidates, minGap) {
  const kept = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (kept.every((p) => Math.abs(p.t - c.t) >= minGap)) kept.push(c);
  }
  return kept;
}

// --------------------------------------------------------------- signals

/**
 * Whole-video motion curve: mean absolute luma change between consecutive
 * low-res grayscale frames.
 *
 * Same technique as reframe.js's private `motionGrid` (ffmpeg emits raw gray
 * pixels, JS measures them), but whole-video and frame-differenced rather than
 * clip-scoped and region-scoped, so it stays a separate implementation.
 */
export async function motionCurve(source, {
  fps = MOTION_FPS,
  gw = GRID_W,
  gh = GRID_H,
  roi = DEFAULT_ROI,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vzt-motion-"));
  try {
    await exec(
      FFMPEG,
      ["-y", "-i", source, "-vf", `fps=${fps},scale=${gw}:${gh},format=gray`,
        "-pix_fmt", "gray", "-f", "rawvideo", "g.raw"],
      { cwd: dir, check: true },
    );
    const data = readFileSync(join(dir, "g.raw"));
    const frameSize = gw * gh;
    const n = Math.floor(data.length / frameSize);
    const y0 = Math.max(0, Math.floor(gh * roi[0]));
    const y1 = Math.min(gh, Math.ceil(gh * roi[1]));
    const roiPixels = Math.max(1, (y1 - y0) * gw);
    const out = [];
    for (let f = 1; f < n; f++) {
      const a = (f - 1) * frameSize;
      const b = f * frameSize;
      let acc = 0;
      let wsum = 0;
      let wx = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < gw; x++) {
          const i = y * gw + x;
          const d = Math.abs(data[b + i] - data[a + i]);
          acc += d;
          if (d >= 6) {
            wsum += d;
            wx += d * x;
          }
        }
      }
      // `cx` is where the movement sits horizontally, 0..1. Tracking how it
      // drifts over a play gives the camera/action direction, which is what
      // makes a whip-pan transition match instead of just being a slide.
      out.push({ t: f / fps, v: acc / roiPixels, cx: wsum > 0 ? wx / wsum / gw : 0.5 });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Reject a semantic-search result that isn't actually discriminating.
 *
 * `vintel search` in lite mode scores each frame with
 * `zero-shot-image-classification` passing a SINGLE candidate label. Softmax
 * over one class is always exactly 1.0, so every frame of every video scores 1
 * for every query — a control query of "a purple elephant eating spaghetti"
 * returns the same hits as "a quarterback throwing a football". That is an
 * upstream bug in vzt-video-intel, but the damage here is worse than no signal:
 * uniform scores look like confident matches and quietly steer selection.
 *
 * So: if the scores carry no variance, treat the backend as unavailable.
 */
export function isDegenerate(hits) {
  if (!hits?.length) return true;
  const scores = hits.map((h) => h.score ?? 0);
  const spread = Math.max(...scores) - Math.min(...scores);
  return spread < 1e-6;
}

/**
 * Motion BURST — where something starts happening.
 *
 * Raw motion magnitude cannot tell a play from a sideline crowd milling about;
 * both are "some pixels changed". What separates them is the ONSET: a play
 * begins with a near-simultaneous acceleration (the snap, the break) and then
 * sustains, while milling is flat. This is the same half-wave-rectified
 * derivative used for audio onsets in music.js, applied to the video.
 *
 * With semantic search unavailable, this is the signal that actually finds the
 * football rather than the football field.
 */
export function motionBurst(curve, { smoothWin = 3 } = {}) {
  if (curve.length < 3) return curve.map((p) => ({ t: p.t, v: 0 }));
  // Smooth first so per-frame noise isn't read as a burst.
  const sm = curve.map((_, i) => {
    let acc = 0;
    let n = 0;
    for (let k = -smoothWin; k <= smoothWin; k++) {
      const j = i + k;
      if (j < 0 || j >= curve.length) continue;
      acc += curve[j].v;
      n++;
    }
    return acc / n;
  });
  const out = [];
  for (let i = 0; i < curve.length; i++) {
    const prev = sm[Math.max(0, i - smoothWin)];
    out.push({ t: curve[i].t, v: Math.max(0, sm[i] - prev) });
  }
  return out;
}

/**
 * Turn CLIP search hits for a sport's highlight phrases into a time-indexed
 * "this looks like the sport's money moment" curve.
 */
export function contextCurve(hits, times, { falloff = 2.5 } = {}) {
  return times.map((t) => {
    let best = 0;
    for (const h of hits) {
      const d = Math.abs(h.t - t);
      if (d > falloff) continue;
      best = Math.max(best, h.score * (1 - d / falloff));
    }
    return { t, v: best };
  });
}

// --------------------------------------------------------------- pipeline

/**
 * Score and select plays.
 *
 * @param {string} source
 * @param {object} opts
 * @returns {Promise<Array<{start,end,peak,score,signals,title,reason}>>}
 */
export async function scorePlays(source, {
  sport = "generic",
  count = 8,
  preroll,
  postroll,
  minGap,
  sensitivity = 1.0,
  useIntel = true,
} = {}) {
  const profile = getProfile(sport);
  const pre = preroll ?? profile.preroll;
  const post = postroll ?? profile.postroll;
  const duration = await ffprobeDuration(source);

  // A profile's minGap assumes RAW game film, where plays are tens of seconds
  // apart. An already-cut highlight tape has one every few seconds, and forcing
  // football's 20s gap onto a 75s tape caps the reel at 3 plays however much
  // action it holds. Scale the gap to the material, never above the profile.
  const requested = minGap ?? profile.minGap;
  const gap = Math.min(requested, Math.max(3, duration / Math.max(1, count * 1.5)));
  if (gap < requested) {
    log.info(`short source (${duration.toFixed(0)}s) — play spacing relaxed ${requested}s → ${gap.toFixed(1)}s`);
  }

  log.info(`scoring plays (${profile.label}) — motion + audio + context…`);

  // --- motion (always available; this is the signal that survives silence)
  const motionRaw = await motionCurve(source);
  if (!motionRaw.length) throw new Error("could not read any video frames to score");
  const times = motionRaw.map((p) => p.t);
  const motionN = robustNorm(motionRaw.map((p) => p.v));
  const motion = times.map((t, i) => ({ t, v: motionN[i] }));

  // --- audio (optional: silent film is the common case, not an error)
  //
  // A SILENT track is not the same as a missing one, and this is the exact trap
  // NextPlay documented. A file with an audio stream carrying no sound still
  // yields a curve; `robustNorm` maps that flat line to a constant 0.5, which
  // is not a signal — it is a constant that dilutes every score equally while
  // looking like real data. Measured on real 7-on-7 film: every play came back
  // "audio 0.50". Degenerate audio is therefore DROPPED, so its weight is
  // redistributed to motion and context.
  let audio = null;
  try {
    const curve = await loudnessCurve(source);
    if (curve.length >= 5) {
      const raw = curve.map((p) => p.M);
      const spread = Math.max(...raw) - Math.min(...raw);
      // Anything under -70 LUFS is below any usable recording, including a
      // distant crowd mic — it is the encoder's noise floor, not sound.
      const audible = raw.some((v) => v > -70);
      if (!audible || spread < 1.0) {
        const why = !audible
          ? `nothing above -70 LUFS`
          : `flat (${spread.toFixed(1)} LU range)`;
        log.info(`audio track unusable — ${why}; scoring on motion and context`);
      } else {
        const vals = robustNorm(raw);
        audio = curve.map((p, i) => ({ t: p.t, v: vals[i] }));
      }
    }
  } catch {
    log.info("no usable audio track — scoring on motion and context alone");
  }

  // --- burst: where a play STARTS (always available, needs no model)
  const burstRaw = motionBurst(motionRaw);
  const burstN = robustNorm(burstRaw.map((p) => p.v));
  const burst = times.map((t, i) => ({ t, v: burstN[i] }));

  // --- context (optional: needs a working semantic search)
  let context = null;
  if (useIntel && (await intel.available())) {
    const hits = [];
    let degenerate = false;
    for (const q of profile.highlights) {
      const r = await intel.search(source, q, { topK: 20, minScore: 0.2 });
      const qh = (r?.hits || []).filter((h) => typeof h.t_ms === "number");
      if (qh.length && isDegenerate(qh)) { degenerate = true; break; }
      for (const h of qh) hits.push({ t: h.t_ms / 1000, score: h.score ?? 0.5 });
    }
    if (degenerate) {
      log.info("semantic search returned uniform scores (not discriminating) — ignoring it");
    } else if (hits.length) {
      context = contextCurve(hits, times);
      log.info(`${hits.length} CLIP hits across ${profile.highlights.length} ${profile.label} queries`);
    }
  }

  // --- combine
  const scored = times.map((t) => {
    const s = {
      motion: sampleAt(motion, t),
      burst: sampleAt(burst, t),
      audio: audio ? sampleAt(audio, t) : null,
      context: context ? sampleAt(context, t) : null,
    };
    return { t, score: combine(s), signals: s };
  });

  // Take every local maximum, then rank. An absolute `median + k·MAD` cutoff
  // was tried first and is unusable here: blending three signals produces a
  // smooth series whose MAD is a large fraction of its range, so the threshold
  // can land ABOVE the highest score in the video and select nothing at all
  // (measured: threshold 0.705, max score 0.680). A RELATIVE floor against the
  // best play in this video is both robust and the same rule sports.js already
  // applies — a real play should stand clearly above the rest of this footage,
  // whatever its absolute numbers happen to be.
  const win = Math.max(2, Math.round(1.5 * MOTION_FPS));
  const peaks = [];
  for (let i = 0; i < scored.length; i++) {
    let isMax = true;
    for (let j = Math.max(0, i - win); j <= Math.min(scored.length - 1, i + win); j++) {
      if (scored[j].score > scored[i].score) { isMax = false; break; }
    }
    if (isMax) peaks.push(scored[i]);
  }

  const dbThresh = audio
    ? deadBallThresholds(motion.map((p) => p.v), audio.map((p) => p.v))
    : null;
  const live = dbThresh ? peaks.filter((p) => !looksDeadBall(p.signals, dbThresh)) : peaks;
  const dropped = peaks.length - live.length;
  if (dropped) log.info(`${dropped} loud-but-still moment(s) rejected as dead ball`);

  const spaced = suppress(live, gap);
  // sensitivity scales the floor: higher = stricter = fewer, weaker plays cut.
  const top = spaced.length ? spaced[0].score : 0;
  const floorFrac = Math.max(0.05, Math.min(0.9, 0.35 * sensitivity));
  const kept = spaced.filter((p) => p.score >= top * floorFrac).slice(0, count);
  if (!kept.length) {
    throw new Error(
      "no plays found — the footage has no moment that stands out. Try --sensitivity 0.5, " +
        "or check that the video actually contains game action.",
    );
  }

  // Anchor each window on where the play STARTS, then set the ramp anchor to
  // the busiest instant inside it.
  //
  // Scoring peaks on the blended maximum, which on a pass play lands somewhere
  // in the middle — so a window centred there opens after the throw and closes
  // before the catch, which is exactly the "we're missing the action" problem.
  // Backing up to the burst onset captures the whole play: snap, throw, catch.
  const clips = kept
    .map((p) => {
      const onset = burstOnsetBefore(burst, p.t, pre);
      const start = Math.max(0, onset - LEAD_IN);
      const end = Math.min(duration, start + pre + post);
      return {
        start,
        end,
        // The ramp should hit the moment of impact — the busiest instant in the
        // window — not the arbitrary point the blended score happened to peak.
        peak: busiestIn(motion, start, end) ?? p.t,
        score: +p.score.toFixed(3),
        signals: p.signals,
        // Direction the action travels — consumed by the planner to pair shots
        // into whip-pan transitions. Measured over a TIGHT window around the
        // impact: only a couple of seconds ever reach the screen, and averaging
        // across the whole candidate folds approach and aftermath into one
        // number that cancels out (measured: 2-6x under-read, no whip ever
        // qualified).
        // A compact motion trace for this candidate, so the planner can pick the
        // sub-window that never goes still. Selecting on the PEAK alone yields
        // windows that contain the peak and several seconds of players standing
        // around, which is what makes a hype reel feel like it keeps pausing.
        samples: motionRaw
          .filter((q) => q.t >= start - 0.5 && q.t <= end + 0.5)
          .map((q) => ({ t: +q.t.toFixed(2), v: +(sampleAt(motion, q.t) ?? 0).toFixed(3) })),
        motionDir: +motionDirection(
          motionRaw,
          Math.max(0, p.t - SHOT_DIR_WINDOW),
          Math.min(duration, p.t + SHOT_DIR_WINDOW),
        ).toFixed(4),
        title: "Big Play",
        reason:
          `score ${p.score.toFixed(2)} (motion ${fmt(p.signals.motion)}, ` +
          `burst ${fmt(p.signals.burst)}, audio ${fmt(p.signals.audio)}, ` +
          `context ${fmt(p.signals.context)})`,
      };
    })
    .filter((c) => c.end - c.start >= 2)
    .sort((a, b) => a.start - b.start);

  clips.forEach((c, i) => (c.title = `Big Play ${i + 1}`));
  return clips;
}

const fmt = (v) => (v == null ? "n/a" : v.toFixed(2));

/**
 * Which way the action travels across a time window, as a least-squares slope
 * of the motion centroid, in frame-widths per second.
 *
 * A whip pan only reads as a whip when the two shots move the SAME way — cut
 * from a right-to-left move into another right-to-left move. Knowing each
 * play's direction is what lets the planner pair them instead of guessing.
 *
 * @returns {number} negative = leftward, positive = rightward, ~0 = static
 */
export function motionDirection(curve, start, end) {
  const pts = curve.filter((p) => p.t >= start && p.t <= end && typeof p.cx === "number");
  if (pts.length < 3) return 0;
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const mx = pts.reduce((a, p) => a + p.cx, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.cx - mx);
    den += (p.t - mt) * (p.t - mt);
  }
  return den > 0 ? num / den : 0;
}

/**
 * Find candidate shots matching a set of CLIP phrases — used for the B-roll
 * runway and the closing shot.
 *
 * Falls back to evenly-spaced samples when vintel isn't available or returns
 * nothing. The fallback draws from `region`: warm-ups, huddles and player
 * intros live at the START of a recording, celebrations and handshakes at the
 * END, so even without semantic search the guess is better than random.
 *
 * @returns {Promise<Array<{src,start,end,label,score,angle}>>}
 */
export async function findShots(source, queries, {
  count = 6,
  len = 1.8,
  minGap = 4,
  region = [0, 0.25],
  duration = null,
} = {}) {
  const dur = duration ?? (await ffprobeDuration(source));
  const out = [];

  const [rLo, rHi] = region;
  const regFrom = dur * rLo;
  const regTo = dur * rHi;

  if (await intel.available()) {
    const hits = [];
    for (const q of queries) {
      const r = await intel.search(source, q, { topK: 8, minScore: 0.2 });
      for (const h of r?.hits || []) {
        if (typeof h.t_ms === "number") hits.push({ t: h.t_ms / 1000, score: h.score ?? 0.5, label: q });
      }
    }
    // Prefer hits inside the expected region, then backfill from outside it.
    // Region was previously only consulted by the fallback, so a "celebration"
    // match near the START of the film could be chosen as the CLOSING shot —
    // observed on real film, where both outro picks landed in the first 6s.
    const ranked = suppress(hits, minGap);
    const inRegion = ranked.filter((h) => h.t >= regFrom && h.t <= regTo);
    const outRegion = ranked.filter((h) => h.t < regFrom || h.t > regTo);
    for (const h of [...inRegion, ...outRegion].slice(0, count)) {
      const start = Math.max(0, h.t - len / 2);
      out.push({
        src: source,
        start,
        end: Math.min(dur, start + len),
        label: h.label,
        score: h.score,
        angle: null,
      });
    }
  }

  if (out.length < count) {
    const from = Math.max(0, regFrom);
    const to = Math.max(from + len, regTo);
    const need = count - out.length;
    for (let i = 0; i < need; i++) {
      const start = from + ((to - from - len) * i) / Math.max(1, need - 1);
      if (out.some((s) => Math.abs(s.start - start) < minGap)) continue;
      out.push({ src: source, start, end: Math.min(dur, start + len), label: "b-roll", score: 0, angle: null });
    }
  }

  return out.sort((a, b) => a.start - b.start).slice(0, count);
}
