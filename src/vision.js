import { exec, log } from "./util.js";

/**
 * Watching video — frames, read in sequence, by a model.
 *
 * The tool was blind. Selection was tuned entirely from motion and audio
 * statistics, and three separate failures on real footage were invisible to
 * every metric while being obvious in a single frame:
 *
 *   - a file described as a highlight reel turned out to be a warm-up session
 *     with no throws or catches in it at all;
 *   - a semantic search reported confident matches that were uniform noise;
 *   - "the action" the scorer picked was players standing with hands on hips,
 *     because a sideline body near the lens outweighs a receiver fifty yards
 *     downfield in pixel terms.
 *
 * This module is the fix: extract frames, hand their PATHS to `claude -p`, and
 * let it Read them. That is genuinely watching — sampled rather than
 * continuous, which is also how video models work internally.
 *
 * The mechanism is ported from vzt-reel-studio (`src/llm.js` VISION_PREFIX +
 * `src/verify/tier1.js` batching), which already proved it in this fleet:
 *
 *   - the invocation prefix is FROZEN so separate processes share the one-hour
 *     prompt cache; only the model, schema and piped prompt vary
 *   - the prompt goes over stdin, never argv
 *   - one call covers a batch of frames rather than one call per frame
 *   - `--json-schema` forces a closed-enum answer that code can trust
 *
 * Cost is not the obstacle. A 512px JPEG is ~197 vision tokens, so a full
 * minute sampled once a second is ~13k tokens — cheaper than most single file
 * reads. Bulk labelling runs on haiku for that reason.
 */

// Frozen prefix. Changing ANY of these busts the shared prompt cache, so the
// only things allowed to vary per call are --model, --json-schema and stdin.
const SYSTEM_PROMPT =
  "You are a vision stage inside vzt-reel-clipper, a sports video editing tool. " +
  "Your entire output is parsed by code, not read by a human. Return exactly what " +
  "the task asks for — no preamble, no markdown fences, no commentary.";

const VISION_PREFIX = [
  "-p",
  "--output-format", "json",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--system-prompt", SYSTEM_PROMPT,
  "--disallowed-tools", "Bash", "Edit", "Write", "Glob", "Grep", "WebSearch", "WebFetch", "Task", "TodoWrite", "NotebookEdit",
  "--allowed-tools", "Read",
];

/** A 512px-wide JPEG costs roughly this many vision tokens (w*h/750). */
export const TOKENS_PER_FRAME = 197;

/** Frames per batched call. ~20 keeps one request comfortably small. */
export const BATCH_SIZE = 20;

/**
 * What a frame can be. Deliberately a CLOSED set: an open-ended description
 * cannot be counted, and counting is what the planner needs.
 */
export const FRAME_LABELS = [
  "action",       // live play — the ball is live and players are competing
  "broll",        // warm-ups, drills, walking, standing between plays
  "celebration",  // players reacting to something that just happened
  "crowd",        // spectators, sideline, coaches, empty field
  "unclear",      // genuinely cannot tell at this resolution
];

export const WATCH_SCHEMA = {
  type: "object",
  required: ["frames"],
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        required: ["t", "label", "description"],
        properties: {
          t: { type: "number" },
          label: { enum: FRAME_LABELS },
          description: { type: "string", maxLength: 160 },
          // Only meaningful when label === "action".
          ballVisible: { type: "boolean" },
          subjects: { type: "integer" },
        },
      },
    },
  },
};

/** Estimated vision tokens for a frame count — printed before any spend. */
export function estimateTokens(frameCount) {
  return frameCount * TOKENS_PER_FRAME;
}

/**
 * Is `claude` on PATH? Cached. Watching degrades to measurement-only rather
 * than failing the run, the same fail-soft contract as src/intel.js.
 */
let availableCache = null;
export async function available() {
  if (availableCache != null) return availableCache;
  try {
    const { code } = await exec("claude", ["--version"], { shell: process.platform === "win32" });
    availableCache = code === 0;
  } catch {
    availableCache = false;
  }
  if (!availableCache) log.info("claude CLI not available — skipping the vision pass");
  return availableCache;
}

/**
 * Label one batch of frames.
 *
 * @param {Array<{t:number, path:string}>} frames
 * @param {object} opts  { sport, model, mock }
 * @returns {Promise<Array<object>>} one entry per frame (may be shorter on a partial answer)
 */
async function labelBatch(frames, { sport = "sport", model = "haiku", mock } = {}) {
  const list = frames.map((f) => `t=${f.t.toFixed(2)}s (${f.path})`).join("\n");

  const prompt =
    `These are frames sampled in time order from a ${sport} video. Read EACH image and ` +
    `classify what is happening in it. Return one entry per frame, in the same order, ` +
    `with the same t value.\n\n` +
    `Labels:\n` +
    `- action: live play in progress — a pass, run, shot, tackle, catch; players actively competing\n` +
    `- broll: warm-ups, drills, players walking or standing between plays, huddles\n` +
    `- celebration: players reacting to something that just happened\n` +
    `- crowd: spectators, sideline, coaches, or an empty field with no play\n` +
    `- unclear: you genuinely cannot tell at this resolution\n\n` +
    `Be strict about "action". Players standing around waiting for the next rep is broll, ` +
    `NOT action, even if many people are in frame. If the ball is not in play, it is not action.\n` +
    `description: one short factual clause about what is visible. No adjectives about quality.\n\n` +
    `FRAMES:\n${list}`;

  if (mock) {
    const out = await mock(prompt, frames);
    return out?.frames ?? [];
  }

  const args = [...VISION_PREFIX, "--model", model, "--json-schema", JSON.stringify(WATCH_SCHEMA)];
  const { stdout, code, stderr } = await exec("claude", args, {
    stdin: prompt,
    shell: process.platform === "win32",
  });
  if (code !== 0) throw new Error(`claude -p failed (exit ${code}):\n${stderr.slice(-600)}`);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p returned a non-JSON envelope:\n${stdout.slice(0, 400)}`);
  }
  if (envelope.is_error) throw new Error(`claude -p reported an error: ${envelope.result}`);

  const text = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result);
  const parsed = envelope.structured_output ?? safeParse(text);
  return parsed?.frames ?? [];
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Label every frame, batching as needed.
 *
 * Results are matched back to the requested frames by TIMESTAMP rather than by
 * array position: a model that returns 19 entries for 20 frames would
 * otherwise silently shift every later label onto the wrong moment.
 *
 * @returns {Promise<Array<{t, path, label, description, ballVisible?, subjects?}>>}
 */
export async function labelFrames(frames, opts = {}) {
  if (!frames.length) return [];
  if (!opts.mock && !(await available())) return [];

  const out = [];
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    const batch = frames.slice(i, i + BATCH_SIZE);
    let labelled = [];
    try {
      labelled = await labelBatch(batch, opts);
    } catch (err) {
      log.warn(`vision batch ${i / BATCH_SIZE + 1} failed: ${err.message.split("\n")[0]}`);
    }
    for (const f of batch) {
      const hit = labelled.find((r) => Math.abs((r.t ?? -1) - f.t) < 0.26);
      out.push({
        ...f,
        label: hit?.label ?? "unclear",
        description: hit?.description ?? "",
        ballVisible: hit?.ballVisible,
        subjects: hit?.subjects,
      });
    }
    log.info(`watched ${Math.min(i + BATCH_SIZE, frames.length)}/${frames.length} frames`);
  }
  return out;
}

/**
 * Fraction of frames carrying each label. This is the number that answers
 * "does this file actually contain the sport?" — the question that went
 * unasked while a warm-up tape was tuned as though it were game film.
 */
export function labelMix(labelled) {
  const mix = Object.fromEntries(FRAME_LABELS.map((l) => [l, 0]));
  for (const f of labelled) mix[f.label] = (mix[f.label] ?? 0) + 1;
  const n = Math.max(1, labelled.length);
  for (const k of Object.keys(mix)) mix[k] = +(mix[k] / n).toFixed(3);
  return mix;
}
