/**
 * Is this candidate window actually a PLAY?
 *
 * ── Why this module exists ───────────────────────────────────────────────
 *
 * `score.js` ranks how *interesting* a window is. It does not answer whether
 * anything happened, and on real footage those come apart badly. This reel
 * shipped a cut whose 4th shot was a camera pan across an empty building: it
 * scored well because the whole frame moved, which is exactly what a pan does.
 *
 * The same defect was found and fixed in the NextPlay hype reel (T38 §7a) from
 * an identical report — "at 13 seconds it shows dead space, no action" — on
 * remarkably similar footage. Pulling that clip's frames showed players standing
 * around a field of hurdles for its entire length. Ranked by its composite
 * score, on one real 11-clip reel:
 *
 *   0.46    "Player DRIVES TOWARD BASKET ... defensive pressure"   a play   in
 *   0.42    "... RATHER THAN COMPETITIVE GAME ACTION"              not      in
 *   0.41    "game IN PROGRESS ... players SPREAD ACROSS COURT"     not      in
 *   0.3325  "Player ATTEMPTING OFFENSIVE ACTION against defenders" a play   OUT
 *
 * Two non-plays outranked a real one. No amount of within-window tuning fixes
 * that, because the ranking signal never asked the question.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * QUALITY OUTRANKS SCORE. Sort by tier first, and only use the numeric score to
 * order within a tier.
 *
 * ── Where we differ from NextPlay, deliberately ──────────────────────────
 *
 * NextPlay classifies by regex over the model's own words, because its browser
 * preview cannot fetch video at selection time and preview and render MUST agree
 * exactly. It says so plainly, and names the better answer:
 *
 *   "Actual motion in the footage is the real ground truth, and it is the right
 *    long-term answer. It also means fetching video, which the browser preview
 *    cannot do at selection time."
 *
 * This tool is a local CLI standing next to the file, and `vision.js` already
 * labels frames `action` / `broll` / `crowd` by looking at them. So we take the
 * answer they could not: classify from LABELS when we have them, and fall back
 * to their text heuristic when we do not.
 */

/**
 * Target runtime, in seconds.
 *
 * 30s is the Instagram Reels / TikTok ceiling and the YouTube Shorts floor — the
 * one length that works everywhere. The budget is 32 rather than 30 so a play
 * landing at 31.5s is included instead of leaving the reel at 24s; overshoot is
 * far cheaper on this form than a cut that ends before it built to anything.
 */
export const HYPE_TARGET_SECONDS = 32;

/**
 * Never fewer than 3 — two plays is a clip pair, not a reel. Never more than 8;
 * past that the runtime lands where a full highlight already lives.
 */
export const HYPE_MIN_CLIPS = 3;
export const HYPE_MAX_CLIPS = 8;

/**
 * Fraction of a window's frames that must read `action` for the window to be a
 * play.
 *
 * Half rather than a token few: a window is a play if a play is what it mostly
 * shows. One action frame inside three seconds of milling is a player jogging
 * past, and cutting to it produces exactly the dead space this module exists to
 * stop.
 */
const ACTION_FRACTION = 0.5;

/**
 * Two picks from the same source this close together are the same moment.
 *
 * NextPlay dedupes on camera-roll sequence number, because its input is many
 * short files and the duplicate case is two takes of one drill (`IMG_9950`,
 * `IMG_9951`). Our input is usually ONE long recording, so the equivalent
 * mistake is two windows a couple of seconds apart in the same file — which is
 * how a reel came to open and close on the very same footage. The intent ports
 * exactly; only the identity test changes.
 */
export const SAME_MOMENT_SECONDS = 4;

/** Tier, best first. */
export const QUALITY_TIERS = ["action", "scene", "no-action"];

/** Ranking tier — higher is better. Sorted on BEFORE any score. */
export function playQualityRank(q) {
  return q === "action" ? 2 : q === "scene" ? 1 : 0;
}

/**
 * The model asserting, in its own words, that nothing happened.
 *
 * Ported from NextPlay's `play-quality.ts`. It matches an ASSERTION, never a
 * stray keyword — an earlier version there matched bare `referee|whistle|
 * stoppage` anywhere in the text and threw away real plays whose description
 * merely named an official. "drill" alone must not qualify either: "beat the
 * defender on a drill route" is a play.
 */
const NO_ACTION_RE = new RegExp(
  [
    String.raw`rather than (?:a )?(?:competitive|peak|actual|real)?\s*game`,
    String.raw`\bno (?:clear|significant|real|actual|apparent)\b[^.]{0,40}\b(?:game|competitive|scoring|play)\b`,
    String.raw`\bnot (?:actual|real|competitive) game\b`,
    String.raw`\b(?:practice/training|training) (?:scenario|session)\b`,
    String.raw`\bstructured practice\b`,
    String.raw`\bconditioning\b`,
    // Widened from NextPlay's `warm[-\s]?ups?`, which misses the participle —
    // "athletes warming up" is the phrasing our labeller actually produces.
    String.raw`\bwarm(?:ing)?[-\s]?ups?\b`,
    // Ours: the failure this repo actually shipped — a pan over scenery.
    String.raw`\b(?:empty (?:field|stadium|frame)|no players?(?: (?:visible|in frame))?)\b`,
    String.raw`\bcamera (?:pan|panning|pans)\b[^.]{0,30}\b(?:building|stands|sky|empty)\b`,
  ].join("|"),
  "i",
);

/**
 * A singular player performing a named action. Requires BOTH halves — a subject
 * that is one player, and a verb that is a thing they did. "Players spread
 * across court" has a subject and no action; "dynamic movement between teams"
 * has an action and no subject. Neither is a play.
 */
const PLAYER_SUBJECT_RE =
  /\b(?:the |a |one )?(?:player|athlete|runner|quarterback|receiver|back|defender|guard|forward|striker|keeper|goalie|batter|pitcher|#\d+|no\.\s?\d+)\b/i;

const ACTION_VERB_RE = new RegExp(
  String.raw`\b(?:` +
    [
      "drives?", "driving", "sprints?", "sprinting", "rushes", "rushing",
      "charges", "breaks? (?:away|free|through|a tackle)", "breakaway",
      "cuts? (?:back|inside|upfield)", "jukes?", "dodges?", "weaves?",
      "accelerat(?:es|ing)", "burst(?:s|ing)?",
      "shoots?", "shooting", "scores?", "scoring", "dunks?", "finishes",
      "catch(?:es|ing)?", "receives?", "throws?", "throwing", "passes",
      "kicks?", "strikes?", "heads?", "volleys?", "spikes?", "serves?",
      "dribbl(?:es|ing)", "crosses",
      "tackl(?:es|ing)", "intercepts?", "blocks?", "strips?", "steals?",
      "saves?", "deflects?", "recovers?", "presses",
      "attempt(?:s|ing)? (?:an? )?(?:offensive|defensive|scoring)",
      "makes? (?:an? )?(?:explosive|athletic|strong)",
    ].join("|") +
    String.raw`)\b`,
  "i",
);

/**
 * Classify a written description. The fallback path, used when no frame labels
 * are available.
 *
 * Order matters: an explicit "no game action" assertion outranks any action verb
 * in the same sentence, because the model is describing what it did NOT see.
 */
export function classifyPlayDescription(description) {
  const desc = description ?? "";
  if (!desc.trim()) return "scene";
  if (NO_ACTION_RE.test(desc)) return "no-action";
  if (PLAYER_SUBJECT_RE.test(desc) && ACTION_VERB_RE.test(desc)) return "action";
  return "scene";
}

/**
 * Classify a time window from watched frame labels. The preferred path — this is
 * measured rather than inferred from prose.
 *
 * `unclear` frames are excluded from the denominator rather than counted
 * against: a window the model could not read at thumbnail resolution should not
 * be demoted for the sampler's benefit. A window that is ENTIRELY unclear has no
 * evidence either way and classifies as "scene", which keeps it eligible but
 * behind anything we actually saw a play in.
 *
 * @param {Array<{t:number,label:string}>} labels  from vision.labelFrames
 * @param {number} start  window start, seconds
 * @param {number} end    window end, seconds
 * @returns {"action"|"scene"|"no-action"|null}  null when no frames cover it
 */
export function qualityFromLabels(labels, start, end) {
  const inside = (labels || []).filter((f) => f && f.t >= start && f.t <= end);
  if (!inside.length) return null;

  const readable = inside.filter((f) => f.label !== "unclear");
  if (!readable.length) return "scene";

  const action = readable.filter((f) => f.label === "action").length;
  if (action / readable.length >= ACTION_FRACTION) return "action";

  // Nothing but spectators, sideline, or an empty field is an assertion that
  // there is no play here — the strongest negative signal available, and the
  // one that keeps a scenery pan out of the cut.
  if (!action && readable.every((f) => f.label === "crowd")) return "no-action";

  return "scene";
}

/**
 * Tier for one candidate, preferring measured labels over prose.
 *
 * @param {object} play    { at|srcStart, end|srcEnd, label|description }
 * @param {Array}  labels  frame labels, or null
 */
export function classifyPlay(play, labels = null) {
  const start = play.srcStart ?? play.start ?? play.at ?? 0;
  const end = play.srcEnd ?? play.end ?? start;
  const fromLabels = labels ? qualityFromLabels(labels, start, end) : null;
  return fromLabels ?? classifyPlayDescription(play.description ?? play.label);
}

/** Would taking this candidate replay a moment already in the cut? */
function sameMoment(candidate, picked) {
  const a = candidate.srcStart ?? candidate.start ?? 0;
  const aEnd = candidate.srcEnd ?? candidate.end ?? a;
  return picked.some((p) => {
    if ((p.src ?? null) !== (candidate.src ?? null)) return false;
    const b = p.srcStart ?? p.start ?? 0;
    const bEnd = p.srcEnd ?? p.end ?? b;
    // Overlapping, or separated by less than one moment's worth of footage.
    if (a < bEnd && b < aEnd) return true;
    return Math.min(Math.abs(a - bEnd), Math.abs(b - aEnd)) < SAME_MOMENT_SECONDS;
  });
}

/**
 * Order the chosen plays for a hype cut.
 *
 * Open on the BEST play and close on the SECOND best, with the weakest buried in
 * the middle. This is where the hype form departs from a narrative highlight,
 * which opens on the second-best and saves the best for a climax: that arc
 * assumes the viewer is already watching. A hype reel has to earn the second it
 * takes someone to decide, so the hook comes first.
 *
 * Sorting on score alone would open on whatever scored highest — which, before
 * the tier gate, was a wide scene shot. The comparator is the SAME one the
 * ranking uses so the opener is a real play whenever one exists.
 */
export function orderForHype(plays, quality) {
  if (plays.length <= 2) return [...plays];
  const strongestFirst = [...plays].sort(cmp(quality));
  const [best, ...rest] = strongestFirst;
  // `rest` is descending, so reversing puts the strongest remaining play last.
  return [best, ...rest.reverse()];
}

/** Tier first, then score, then a stable tiebreak on source position. */
function cmp(quality) {
  return (a, b) => {
    const q = playQualityRank(quality.get(b)) - playQualityRank(quality.get(a));
    if (q !== 0) return q;
    const d = (b.score ?? 0) - (a.score ?? 0);
    // Stable tiebreak. Without it two equally-scored plays can order differently
    // between a dry run and the render, and near-identical scores are common.
    if (d !== 0) return d;
    return (a.srcStart ?? a.start ?? 0) - (b.srcStart ?? b.start ?? 0);
  };
}

/**
 * Pick and order the plays for a hype cut.
 *
 * Pure and deterministic: the same plays in, the same plays out, every time.
 *
 * @param {Array} plays  candidates with { src, srcStart, srcEnd, score, label? }
 * @param {object} opts  { targetSeconds, labels, minClips, maxClips }
 * @returns {{picked:Array, quality:Map, dropped:Array}}
 */
export function pickHypeClips(plays, opts = {}) {
  const target = opts.targetSeconds ?? HYPE_TARGET_SECONDS;
  const minClips = opts.minClips ?? HYPE_MIN_CLIPS;
  const maxClips = opts.maxClips ?? HYPE_MAX_CLIPS;
  const labels = opts.labels ?? null;

  const quality = new Map(plays.map((p) => [p, classifyPlay(p, labels)]));
  if (!plays.length) return { picked: [], quality, dropped: [] };

  const ranked = [...plays].sort(cmp(quality));
  const bestTier = playQualityRank(quality.get(ranked[0]));

  const picked = [];
  const dropped = [];
  let seconds = 0;

  for (const play of ranked) {
    if (picked.length >= maxClips) {
      dropped.push({ play, why: "max clips" });
      continue;
    }

    // NEVER SHOW THE SAME MOMENT TWICE. A hard rule that outranks the clip
    // floor: a viewer who sees the same footage twice concludes the tool is
    // broken, which is worse than a cut that runs short.
    if (sameMoment(play, picked)) {
      dropped.push({ play, why: "same moment already in the cut" });
      continue;
    }

    // A SHORT REEL BEATS A PADDED ONE. Once the floor is met, never reach into a
    // lower tier just to hit the runtime target — that is precisely how a shot
    // of players milling around lands in the middle of a hype reel. Better a
    // genuine 20s cut of three real plays than a 32s one with two duds.
    //
    // On footage with healthy detection most windows classify `action`, so this
    // never binds. It bites when detection was poor, which is when it matters.
    const here = playQualityRank(quality.get(play));
    if (picked.length >= minClips && here < bestTier) {
      dropped.push({ play, why: "would drop below the best available tier" });
      break;
    }

    // Never pad with a window we looked at and saw no play in.
    if (picked.length >= minClips && quality.get(play) === "no-action") {
      dropped.push({ play, why: "no action in frame" });
      break;
    }

    if (seconds >= target && picked.length >= minClips) {
      dropped.push({ play, why: "runtime target met" });
      break;
    }

    picked.push(play);
    seconds += Math.max(0, (play.srcEnd ?? play.end ?? 0) - (play.srcStart ?? play.start ?? 0));
  }

  return { picked: orderForHype(picked, quality), quality, dropped };
}
