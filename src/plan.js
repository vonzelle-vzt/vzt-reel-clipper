import { getProfile } from "./profiles.js";
import { classifyPlay, playQualityRank } from "./quality.js";
import { log } from "./util.js";

/**
 * The edit plan — the editing doctrine expressed as data.
 *
 * Everything here comes from how good sports edits are actually cut, and the
 * point of putting it in one pure module is that each rule becomes an assertion
 * instead of a matter of taste:
 *
 *  1. EDIT TO THE MUSIC. Shots are allocated in whole BEATS off the grid from
 *     music.js, not in seconds. Cuts therefore land on the beat by
 *     construction — there is no snapping step that can be off by a frame.
 *
 *  2. HOOK FIRST. The best play is placed on the bass drop, ~5-6s in, after a
 *     short B-roll intro. This is the single biggest change from the old sports
 *     mode, which sorted plays chronologically and buried the best one.
 *
 *  3. PACING IS A ROLLERCOASTER. Shot lengths follow an energy curve — build,
 *     deliberately slow down, then rebuild to a climax. Uniform clip lengths
 *     are what makes an edit feel flat, and the old fixed 7s preroll + 4s
 *     postroll made every single clip exactly 11 seconds.
 *
 *  4. ALTERNATE. Action against B-roll, and angle against angle. A straight
 *     highlight tape is boring; the emotion clips are what make it a story.
 *
 *  5. RAMP THE IMPACT. Each action shot slows into its scored peak and speeds
 *     back out, rather than running the whole clip in slow motion.
 *
 * Output is an EDL consumed by composite.js. No I/O happens here, so the whole
 * doctrine is unit-testable without rendering a frame.
 */

/**
 * Shot-length energy curves, as piecewise-linear control points (position →
 * energy). Energy 1 = shortest/fastest shot, 0 = longest/slowest.
 */
export const ARCS = {
  // Build → break → rebuild. "It's easy to build tension and momentum, but
  // it's hard to keep it": the dip at 0.6 is the deliberate slow-down.
  rollercoaster: [[0, 0.35], [0.45, 0.9], [0.6, 0.28], [0.95, 1], [1, 0.9]],
  // Monotonic acceleration — relentless, good for very short reels.
  build: [[0, 0.3], [1, 1]],
  // Even pacing; mostly useful as a control when comparing edits.
  steady: [[0, 0.6], [1, 0.6]],
};

const BEATS_SLOWEST = 8; // 2 bars for a held, low-energy shot
const BEATS_FASTEST = 2; // half a bar at peak energy

// Minimum |motionDir| (frame-widths/sec) for a shot to count as "moving" and be
// eligible for a whip pan. Below this the action is essentially static and a
// whip would be a transition applied to nothing.
const WHIP_MIN_DIR = 0.02;

// Floor for ACTION shots, in beats. Below roughly two seconds a viewer cannot
// register a catch or a tackle — the shot reads as a flicker of bodies.
const ACTION_MIN_BEATS = 4; // fallback when a profile doesn't set one

/** Interpolate a piecewise-linear curve at x in [0,1]. */
export function arcEnergy(arc, x) {
  const pts = ARCS[arc] || ARCS.rollercoaster;
  const t = Math.max(0, Math.min(1, x));
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (t <= x1) {
      const f = x1 === x0 ? 0 : (t - x0) / (x1 - x0);
      return y0 + (y1 - y0) * f;
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Beats a shot should last at a given energy.
 *
 * `min` exists because ACTION and B-roll have different floors. A viewer needs
 * to see the ball arrive and be caught — roughly a second either side of the
 * impact — so a 2-beat action shot (0.94s at 128 BPM) shows a blur of players
 * and none of the play. B-roll has no such constraint and can snap past.
 */
export function beatsForEnergy(e, { min = BEATS_FASTEST } = {}) {
  return Math.max(
    min,
    Math.round(BEATS_SLOWEST - (BEATS_SLOWEST - BEATS_FASTEST) * Math.max(0, Math.min(1, e))),
  );
}

/** Index of the beat nearest `t`. */
export function nearestBeatIndex(beats, t) {
  if (!beats?.length) return 0;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const a = Math.max(0, lo - 1);
  return Math.abs(t - beats[a]) <= Math.abs(beats[lo] - t) ? a : lo;
}

/**
 * Solve the source window for a ramped shot.
 *
 * A shot occupies a fixed slot on the timeline (a whole number of beats). If
 * part of it plays at `speed`, the SOURCE must be shorter than the slot to
 * still fill it:
 *
 *   timeline = (srcTotal - slowSrc) + slowSrc / speed
 *   ⇒ srcTotal = timeline - slowSrc·(1/speed - 1)
 *
 * The slow window is sized as a FRACTION of the slot, not as a fixed number of
 * seconds. A fixed 1.2s window at 0.4x costs 1.8s of timeline, which is more
 * than a typical 2-3 beat shot has to give — every ramp then fails to fit and
 * the feature silently does nothing while still appearing to be enabled.
 *
 * Returns null only when even a scaled ramp cannot fit, in which case the
 * caller renders the shot unramped rather than producing something mistimed.
 */
export function solveRamp(timelineDur, { slowFrac = 0.3, speed = 0.6, maxSlow = 1.2 } = {}) {
  const slowSrc = Math.min(maxSlow, timelineDur * slowFrac);
  if (slowSrc < 0.15) return null; // too short to read as a ramp at all
  const cost = slowSrc * (1 / speed - 1);
  const srcTotal = timelineDur - cost;
  if (srcTotal <= slowSrc + 0.1) return null;
  return { srcTotal, slowSrc, speed };
}


/**
 * Choose the `dur`-second sub-window of a play that keeps MOVING throughout.
 *
 * Anchoring on the peak alone produces windows that contain the peak plus
 * several seconds of players standing around — measured at 37% of a finished
 * reel being near-motionless, which is what makes a hype edit feel like it
 * keeps pausing. Scoring a window by its LOW percentile instead of its peak
 * rewards sustained action and rejects any window containing a stall.
 *
 * @param {Array<{t:number,v:number}>} samples  motion trace over the candidate
 * @param {number} dur                          window length, seconds
 * @returns {number|null} window start time, or null if there is no trace
 */
export function sustainedWindow(samples, dur) {
  if (!samples?.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const s0 of samples) {
    const inWin = samples.filter((q) => q.t >= s0.t && q.t <= s0.t + dur);
    if (inWin.length < 2) continue;
    if (s0.t + dur > samples[samples.length - 1].t + 0.51) break;
    const vals = inWin.map((q) => q.v).sort((a, b) => a - b);
    // 25th percentile: the window is only as good as its quietest stretch.
    const low = vals[Math.floor(vals.length * 0.25)];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const score = low * 0.7 + mean * 0.3;
    if (score > bestScore) { bestScore = score; best = s0.t; }
  }
  return best;
}


/**
 * Choose the next action shot, scoring movement continuity above angle variety.
 *
 * Matching the direction of travel is what makes a plain cut disappear — the
 * viewer's eye is already moving that way, so the join reads as continuous
 * motion rather than as an edit. Varying the angle keeps it from looking
 * repetitive. The ideal next shot does BOTH: a different angle travelling the
 * same way, which is why these are scored together instead of one short-
 * circuiting the other.
 *
 * Ties fall back to the incoming order, which is score-ranked, so a weak match
 * never beats a materially better play.
 *
 * @param {Array} plays        remaining candidates, best-first
 * @param {{lastAngle:?string, lastDir:?number}} prev
 * @returns {number} index into `plays`
 */
export function pickNextPlay(plays, { lastAngle = null, lastDir = null } = {}) {
  if (!plays.length) return 0;
  const MOVING = 0.015; // below this a shot has no direction worth matching
  let best = 0;
  let bestScore = -Infinity;
  plays.forEach((p, i) => {
    let score = 0;
    const d = p.motionDir ?? 0;
    if (lastDir != null && Math.abs(d) >= MOVING && Math.abs(lastDir) >= MOVING) {
      score += Math.sign(d) === Math.sign(lastDir) ? 2 : -1;
    }
    if (p.angle != null && lastAngle != null) score += p.angle !== lastAngle ? 1 : -1;
    score -= i * 0.05; // keep the score ranking as the tie-break
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/**
 * Build the edit plan.
 *
 * @param {object} a
 * @param {{bpm:number, beats:number[], downbeats:number[], drop:number|null, duration:number, path:string}} a.music
 * @param {Array} a.plays   scored action clips (from score.js), best first is NOT assumed
 * @param {Array} a.broll   candidate B-roll/emotion shots [{src,start,end,angle}]
 * @param {Array} a.outro   candidate closing shots
 * @param {string} a.sport
 * @param {object} a.opts   { arc, grade, ramps, maxDuration, transitions }
 * @returns {object} EDL
 */
export function planEdit({ music, plays, broll = [], outro = [], sport = "generic", opts = {} }) {
  const profile = getProfile(sport);
  const beats = music.beats || [];
  if (beats.length < 8) throw new Error("music track has too few beats to plan an edit");

  const arc = opts.arc || "rollercoaster";
  // How long an action shot must hold for the play to read. Sport-specific: a
  // deep pass needs the throw, the flight and the catch; a dunk does not.
  const actionMinBeats = opts.minShotBeats ?? profile.minShotBeats ?? ACTION_MIN_BEATS;
  const grade = opts.grade || "punch";
  // A single subtle texture strength for the whole reel — 0 disables it.
  const grain = opts.grain ?? 0.35;
  const useRamps = opts.ramps !== false;
  // How many plays get a speed ramp. Ramping EVERY action shot is what made the
  // reel feel like it kept pausing: a 0.5x section on 30fps source duplicates
  // every frame, and with ten ramped shots a third of the finished reel was
  // duplicate frames. Ramps are an accent — they land hardest when they are the
  // exception, so only the strongest plays get one.
  const rampBudget = opts.rampCount ?? Math.max(1, Math.ceil(plays.length * 0.35));
  const transitions = opts.transitions !== false;

  // Timeline is bounded by the music, by an optional --duration, and by how
  // much material we actually have.
  const maxT = Math.min(music.duration, opts.maxDuration || music.duration);
  const lastBeat = Math.max(0, beats.findIndex((t) => t > maxT));
  const endIdx = lastBeat > 0 ? lastBeat : beats.length - 1;

  // The hook lands on the drop. With no detectable drop, fall back to ~2 bars
  // in, which is where a drop usually is anyway on edit-friendly tracks.
  const dropIdx = music.drop != null ? nearestBeatIndex(beats, music.drop) : Math.min(8, endIdx - 8);

  // QUALITY OUTRANKS SCORE.
  //
  // `score` measures how interesting a window is, never whether a play happened,
  // and on real footage those come apart. This line used to sort on score alone,
  // which put a camera pan across an empty building into a shipped cut ahead of
  // three real plays — the pan scored well precisely because the whole frame
  // moved. See src/quality.js for the measurement.
  const quality = new Map(plays.map((p) => [p, classifyPlay(p, opts.labels ?? null)]));
  const hasPlay = plays.some((p) => quality.get(p) !== "no-action");
  const ranked = plays
    // Drop windows we looked at and saw no play in — unless that is all there
    // is, in which case a thin reel beats no reel and the caller is warned.
    .filter((p) => !hasPlay || quality.get(p) !== "no-action")
    .sort((a, b) => {
      const q = playQualityRank(quality.get(b)) - playQualityRank(quality.get(a));
      if (q !== 0) return q;
      const d = (b.score ?? 0) - (a.score ?? 0);
      // Stable tiebreak: near-identical scores are common, and without this the
      // same input can order differently between a dry run and the render.
      return d !== 0 ? d : (a.start ?? 0) - (b.start ?? 0);
    });
  if (!ranked.length) throw new Error("no plays to build a reel from");
  if (!hasPlay) {
    log.warn("every candidate window classified as no-action — the reel is built from the least-bad of them");
  }

  const shots = [];
  const sfx = [];

  /**
   * Does the track already land a hit here?
   *
   * Downbeats are where the music itself punches, and layering our own impact
   * on top of one muddies both. Editors make this call by ear; encoding it
   * keeps the sound design intentional rather than mechanical.
   */
  const nearDownbeat = (t, tol = 0.07) =>
    (music.downbeats || []).some((d) => Math.abs(d - t) <= tol);
  let bi = 0; // current beat index

  const push = (shot) => {
    shots.push(shot);
    return shot;
  };

  // ------------------------------------------------------------ 1. intro
  // Short B-roll runway into the drop: warm-ups, huddle, emotion. Kept to
  // whatever beats exist before the drop so the hook still lands on time.
  const introBeats = Math.max(0, dropIdx);
  if (introBeats >= 2) {
    const picks = broll.slice(0, introBeats >= 6 ? 3 : 2);
    if (picks.length) {
      const per = Math.floor(introBeats / picks.length);
      let cursor = 0;
      picks.forEach((b, i) => {
        const nB = i === picks.length - 1 ? introBeats - cursor : per;
        if (nB < 1) return;
        const at = beats[cursor];
        const dur = beats[Math.min(endIdx, cursor + nB)] - at;
        push({
          kind: "broll",
          src: b.src,
          srcStart: b.start,
          // Fill the whole slot. A candidate's `end` is a suggestion from the
          // shot finder, not a hard boundary — clamping to it leaves the slot
          // short and puts every later cut off the beat.
          srcEnd: b.start + dur,
          at,
          dur,
          beats: nB,
          angle: b.angle ?? null,
          ramp: null,
          transition: i === 0 ? "hard" : "hard",
          grade,
          grain,
          label: b.label || "intro",
        });
        if (transitions && i > 0) sfx.push({ category: "whoosh", at, variant: i });
        cursor += nB;
      });
    }
    bi = introBeats;
  }

  // A riser leading into the drop is the classic tell that something is coming.
  if (transitions && dropIdx >= 4) {
    sfx.push({ category: "riser", at: beats[Math.max(0, dropIdx - 4)], variant: 0 });
  }

  // ------------------------------------------------------------ 2. the hook
  // Best play, on the drop. This is the rule the old chronological sort broke.
  const used = new Set();
  let ramped = 0;
  const placeAction = (play, nBeats, atBeatIdx, isHook = false) => {
    const at = beats[atBeatIdx];
    const endBeatIdx = Math.min(endIdx, atBeatIdx + nBeats);
    const dur = beats[endBeatIdx] - at;
    if (!(dur > 0)) return null;

    // Land the IMPACT on a beat, not merely the cut.
    //
    // Cutting on the beat while the moment of impact falls at an arbitrary
    // point mid-shot is what makes an edit feel "a little off" even when every
    // cut is mathematically on the grid — what a viewer hears as on-beat is the
    // visual event, not the splice. So the source window is positioned to put
    // the peak on a beat one in from the shot's start: a moment of build, then
    // the hit lands with the music.
    let ramp = null;
    let srcStart = play.start;
    let srcEnd = play.end;
    // The hook always ramps; after that only while the budget lasts.
    const mayRamp = useRamps && play.peak != null && (isHook || ramped < rampBudget);
    const solved = mayRamp ? solveRamp(dur, { speed: opts.rampSpeed ?? 0.6 }) : null;

    // Earliest the impact can land. The slow window is centred on the peak, so
    // it cannot begin before the shot does: with atSrc ≥ 0 the peak's timeline
    // offset is at least slowSrc/(2·speed). Asking for a beat earlier than that
    // clamps atSrc to zero, which silently de-centres the ramp and leaves the
    // impact off the beat anyway — the exact bug this alignment exists to fix.
    const minImpact = solved ? solved.slowSrc / (2 * solved.speed) : 0;
    let impactBeatIdx = atBeatIdx;
    for (let k = atBeatIdx + 1; k <= Math.min(endIdx, atBeatIdx + nBeats - 1); k++) {
      if (beats[k] - at >= minImpact - 1e-6) { impactBeatIdx = k; break; }
      impactBeatIdx = k;
    }
    const impactAt = Math.max(minImpact, beats[impactBeatIdx] - at); // seconds into the shot

    // Prefer the stretch of this play that actually keeps moving; fall back to
    // the scored peak when no motion trace came through.
    const sustained = sustainedWindow(play.samples, solved ? solved.srcTotal : dur);
    const anchorPeak = sustained != null
      ? sustained + (solved ? solved.srcTotal : dur) * 0.45
      : play.peak;

    if (solved) {
      // With the slow window centred on the peak, the peak's TIMELINE offset is
      // p - slowSrc/2 + slowSrc/(2·speed). Solve for p so it lands on `impactAt`.
      const p = impactAt + solved.slowSrc / 2 - solved.slowSrc / (2 * solved.speed);
      const pClamped = Math.max(solved.slowSrc / 2, Math.min(solved.srcTotal - solved.slowSrc / 2, p));
      srcStart = Math.max(0, anchorPeak - pClamped);
      srcEnd = srcStart + solved.srcTotal;
      ramp = {
        // where the slow section starts, relative to the shot's source window
        atSrc: Math.max(0, Math.min(solved.srcTotal - solved.slowSrc, pClamped - solved.slowSrc / 2)),
        slowSrc: solved.slowSrc,
        speed: solved.speed,
      };
      ramped++;
    }
    if (!ramp) {
      const anchor = anchorPeak ?? play.peak ?? (play.start + play.end) / 2;
      srcStart = Math.max(0, anchor - Math.max(0, Math.min(dur, impactAt)));
      srcEnd = srcStart + dur;
    }

    // A whip only reads as a whip when the outgoing and incoming shots travel
    // the SAME way. Where two consecutive action shots share a direction and
    // both actually move, join them with one; otherwise cut hard on the beat,
    // which is the primary device anyway. This is the "natural whip pan" of the
    // doctrine rather than a transition pulled from a pack.
    const prev = shots[shots.length - 1];
    let transition = "hard";
    let whipDir = 0;
    // FLASH CUT on the hook. The drop is the one moment in the reel that can
    // carry an overt accent, and a white blink there is the classic tell. Used
    // sparingly on purpose — flashing every cut is what makes an edit look
    // like a preset pack rather than an edit.
    if (transitions && isHook && shots.length) transition = "flash";
    const d = play.motionDir ?? 0;
    if (
      transitions && prev && prev.kind === "action" && !isHook &&
      Math.abs(d) >= WHIP_MIN_DIR && Math.abs(prev.motionDir ?? 0) >= WHIP_MIN_DIR &&
      Math.sign(d) === Math.sign(prev.motionDir)
    ) {
      transition = "whip";
      whipDir = Math.sign(d);
    }

    const shot = push({
      kind: "action",
      src: play.src,
      srcStart,
      srcEnd,
      at,
      dur,
      beats: nBeats,
      angle: play.angle ?? null,
      peak: play.peak,
      score: play.score,
      motionDir: d,
      ramp,
      transition,
      whipDir,
      grade,
      grain,
      label: play.title || "play",
      hook: isHook,
    });
    if (transitions) {
      // The cut itself. Skipped when the music already lands a hit here — a
      // working editor's note: an impact was deliberately left off a moment
      // because "the hit from the music already lines up". Doubling up muddies
      // both instead of reinforcing either.
      if (!nearDownbeat(at)) sfx.push({ category: "impact", at, variant: shots.length });

      // HIT-TO-SLOW. The impact that actually sells a ramp lands where the
      // picture *slows*, not where the shot starts, and it wants a tail that
      // lingers through the slow section. Straight from the breakdown: going
      // fast and then slowing down feels empty without it, and "it makes a
      // world of a difference" with it.
      //
      // The pre-ramp section plays at 1x, so the slow section's timeline offset
      // is just `atSrc`.
      if (ramp) {
        sfx.push({
          category: "impact",
          at: +(at + ramp.atSrc).toFixed(3),
          variant: shots.length + 1,
          tail: true,
        });
      }
    }
    return shot;
  };

  const hookBeats = Math.max(6, actionMinBeats + 2);
  if (dropIdx + hookBeats <= endIdx) {
    placeAction(ranked[0], hookBeats, dropIdx, true);
    used.add(ranked[0]);
    bi = dropIdx + hookBeats;
  }

  // ------------------------------------------------------------ 3. the body
  // Alternate action and B-roll, vary the angle, and let the arc set lengths.
  const remainingPlays = ranked.filter((p) => !used.has(p));
  const brollPool = broll.slice(3); // intro already consumed the first few
  const outroBeats = 6;
  const bodyEnd = Math.max(bi, endIdx - outroBeats);
  const bodySpan = Math.max(1, bodyEnd - bi);

  let pi = 0;
  let bri = 0;
  let wantAction = true;
  let lastAngle = shots.length ? shots[shots.length - 1].angle : null;
  let lastDir = shots.length ? (shots[shots.length - 1].motionDir ?? null) : null;

  // Drive the arc by progress through the MATERIAL, not through the music.
  // Mapping it to the beat timeline compresses the curve whenever there is less
  // footage than song — the body loop exits early, x never approaches 1, and
  // the final rebuild-to-climax silently never happens. Pacing should be a
  // property of the edit, so it must span exactly the shots we actually have.
  const bodyTotal = Math.max(1, remainingPlays.length + brollPool.length);
  let bodyIndex = 0;
  void bodySpan;

  while (bi < bodyEnd && (pi < remainingPlays.length || bri < brollPool.length)) {
    const x = bodyIndex / Math.max(1, bodyTotal - 1);
    // Decide WHAT is being placed before sizing it. Action needs long enough to
    // read; B-roll can be a flash. Sizing first meant the fall-through branch
    // (wanted B-roll, none left, so place action) sized an action shot with the
    // B-roll floor and produced 3-beat plays the floor was meant to prevent.
    const havePlays = remainingPlays.length > 0;
    const haveBroll = bri < brollPool.length;
    const placingAction = havePlays && (wantAction || !haveBroll);
    const nBeats = Math.min(
      beatsForEnergy(arcEnergy(arc, x), { min: placingAction ? actionMinBeats : BEATS_FASTEST }),
      bodyEnd - bi,
    );
    if (nBeats < 1) break;

    // In the arc's low-energy dip we deliberately hold longer and cross-fade —
    // this is the "slow down and rebuild" beat of the edit.
    const inBreak = arcEnergy(arc, x) < 0.35;

    let placed = null;
    if (wantAction && pi < remainingPlays.length) {
      // MATCH CUT ON MOVEMENT — the highest-value ordering rule there is.
      //
      // Editors rate the match cut above every preset and overlay, and its
      // strongest form is matching the DIRECTION of travel: left-to-right into
      // left-to-right into left-to-right. The eye tracks continuously across
      // the join and simply does not register the cut, which is why a plain
      // cut can outperform a transition effect laid over a mismatched one.
      //
      // `motionDir` was already measured for whip pairing; here it also decides
      // the ORDER. Angle still wants to vary — different angle, same direction
      // is the ideal pairing, so both are scored rather than one overriding
      // the other.
      const pick = pickNextPlay(remainingPlays, { lastAngle, lastDir });
      const play = remainingPlays.splice(pick, 1)[0];
      placed = placeAction(play, nBeats, bi);
    } else if (bri < brollPool.length) {
      const b = brollPool[bri++];
      const at = beats[bi];
      const dur = beats[Math.min(endIdx, bi + nBeats)] - at;
      if (dur > 0) {
        placed = push({
          kind: "broll",
          src: b.src,
          srcStart: b.start,
          // Fill the whole slot. A candidate's `end` is a suggestion from the
          // shot finder, not a hard boundary — clamping to it leaves the slot
          // short and puts every later cut off the beat.
          srcEnd: b.start + dur,
          at,
          dur,
          beats: nBeats,
          angle: b.angle ?? null,
          ramp: null,
          transition: inBreak && transitions ? "xfade" : "hard",
          grade,
          grain,
          label: b.label || "broll",
        });
        if (transitions) sfx.push({ category: "whoosh", at, variant: shots.length });
      }
    } else if (pi < remainingPlays.length) {
      placed = placeAction(remainingPlays.shift(), nBeats, bi);
    }

    if (!placed) break;
    lastAngle = placed.angle;
    if (placed.motionDir != null) lastDir = placed.motionDir;
    bi += nBeats;
    bodyIndex++;
    wantAction = !wantAction;
  }

  // ------------------------------------------------------------ 4. the outro
  // "You don't want to just end it abruptly." Close on celebration/handshake,
  // finishing on a downbeat so the music resolves with the picture.
  //
  // The outro is BOUNDED. When the body loop exits early because we ran out of
  // plays and B-roll, there is a gap between here and the end of the music —
  // stretching the closing shot across it produced a 13-second held frame. A
  // tight reel that ends when the material ends beats a reel padded to fit the
  // song; composite.js trims the music to the finished timeline.
  if (bi < endIdx) {
    const close = outro[0] || broll[broll.length - 1] || null;
    const at = beats[bi];
    const wanted = Math.min(outroBeats + 2, endIdx - bi);
    let endT = beats[Math.min(endIdx, bi + wanted)];
    // Resolve on a downbeat inside that window so the music lands with the cut.
    const db = (music.downbeats || []).filter((t) => t > at && t <= endT + 1e-6);
    if (db.length) endT = db[db.length - 1];
    const dur = endT - at;
    if (close && dur > 0.4) {
      push({
        kind: "outro",
        src: close.src,
        srcStart: close.start,
        srcEnd: Math.min(close.end, close.start + dur),
        at,
        dur,
        beats: wanted,
        angle: close.angle ?? null,
        ramp: null,
        transition: transitions ? "xfade" : "hard",
        grade,
        grain,
        label: close.label || "outro",
      });
    }
  }

  // Close any leading gap.
  //
  // The intro runway is sized in beats up to the drop, but it can only be
  // FILLED if B-roll candidates exist. With none, the hook still starts at the
  // drop and the reel opens with several seconds of nothing — 4.45s of dead air
  // in testing, and since the renderer simply concatenates shots, the finished
  // reel came out 4s shorter than the plan claimed.
  //
  // Shifting the timeline to start at zero and starting the MUSIC later by the
  // same amount keeps picture and track locked, so the hook still lands exactly
  // on the drop — the reel just opens on it.
  let musicOffset = 0;
  const head = shots.length ? shots[0].at : 0;
  if (head > 1e-6) {
    for (const s of shots) s.at = +(s.at - head).toFixed(4);
    for (const c of sfx) c.at = +(c.at - head).toFixed(4);
    musicOffset = +head.toFixed(4);
  }
  // A riser cued before the (now removed) runway has nowhere to play.
  const cues = sfx.filter((c) => c.at >= 0);

  // Duration is the end of the last shot, which after compaction equals the
  // summed slots. Deriving it from `at + dur` alone would keep hiding gaps.
  const total = shots.length ? shots[shots.length - 1].at + shots[shots.length - 1].dur : 0;
  const summed = shots.reduce((a, s) => a + s.dur, 0);

  return {
    sport: profile.key,
    bpm: music.bpm,
    arc,
    grade,
    music: { path: music.path, drop: music.drop, offset: musicOffset },
    beats,
    shots,
    sfx: cues,
    duration: +total.toFixed(3),
    // Guard against any future gap silently reappearing: these must agree.
    contentDuration: +summed.toFixed(3),
    // "Think about that first second as the thumbnail of your video."
    cover: shots.find((s) => s.hook)?.at ?? 0,
  };
}
