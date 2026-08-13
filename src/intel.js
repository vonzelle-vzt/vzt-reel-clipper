import { exec, log } from "./util.js";

/**
 * Fail-soft adapter over the `vintel` (vzt-video-intel) CLI's read-only
 * inspection commands: scene boundaries, keyframes, single-video CLIP
 * search, the fused observe() timeline, and cross-video corpus indexing.
 *
 * This is deliberately separate from src/detect/vintel.js, which shells out
 * to `vintel entities` (cloud SAM2 person tracking) as a pluggable reframe
 * detector and is allowed to throw — callers there opt in explicitly. The
 * functions here back *optional* enrichment (captions, b-roll search,
 * highlight ranking, …) that the rest of the pipeline must be able to run
 * without: any failure — binary missing, non-zero exit, unparseable stdout —
 * resolves to `null` instead of throwing, with a single log.info note.
 *
 * Every command here can be slow on real video (whisper transcription,
 * scene-graph analysis, CLIP scoring). None of it is timed out by this
 * module — callers that invoke these repeatedly (e.g. once per clip) should
 * cache the result themselves rather than re-shelling out.
 */

// Slice the last balanced-looking JSON object out of mixed CLI stdout.
// vintel's read commands print progress/log lines to stdout before the
// final JSON blob (mirrors the bracket-slicing pattern in transcribe.js and
// detect/vintel.js, but braces since these commands emit an object, not an
// array).
function extractJsonObject(stdout) {
  const a = stdout.indexOf("{");
  const b = stdout.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("no JSON object in vintel output");
  return JSON.parse(stdout.slice(a, b + 1));
}

async function runVintel(args) {
  const { stdout, code, stderr } = await exec("vintel", args, {
    shell: process.platform === "win32",
  });
  if (code !== 0) {
    throw new Error(`vintel ${args[0]} failed (exit ${code}): ${stderr.slice(-200)}`);
  }
  return extractJsonObject(stdout);
}

// Fail-soft wrapper: run `fn`, log and return null on any failure instead
// of throwing.
async function tryVintel(label, fn) {
  try {
    return await fn();
  } catch (err) {
    log.info(`vintel ${label} unavailable, skipping (${err.message})`);
    return null;
  }
}

let availableCache = null;

/**
 * Probe once (cached for the process lifetime) whether `vintel` runs at
 * all on this machine. Useful for callers that want to skip a whole
 * enrichment stage up front rather than eat one failed call per function.
 * @returns {Promise<boolean>}
 */
export async function available() {
  if (availableCache != null) return availableCache;
  try {
    const { code } = await exec("vintel", ["--version"], {
      shell: process.platform === "win32",
    });
    availableCache = code === 0;
  } catch {
    availableCache = false;
  }
  if (!availableCache) log.info("vintel CLI not available — intel enrichment disabled");
  return availableCache;
}

/**
 * Scene boundaries via ffmpeg content-change detection.
 * @param {string} source
 * @param {{threshold?: number}} [opts]
 * @returns {Promise<{scenes: Array<{id:number,start_ms:number,end_ms:number}>, duration_ms:number}|null>}
 */
export async function scenes(source, { threshold } = {}) {
  return tryVintel("scenes", async () => {
    const args = ["scenes", source];
    if (threshold != null) args.push("--threshold", String(threshold));
    return runVintel(args);
  });
}

/**
 * Per-scene (or fixed-interval) keyframes as base64 JPEGs.
 * @param {string} source
 * @param {{perScene?: boolean, intervalMs?: number}} [opts]
 * @returns {Promise<{keyframes: Array<{scene_id:number,t_ms:number,jpeg_b64:string}>}|null>}
 */
export async function keyframes(source, { perScene = true, intervalMs = 1000 } = {}) {
  return tryVintel("keyframes", async () => {
    const args = ["keyframes", source];
    if (perScene) args.push("--per-scene");
    else args.push("--interval-ms", String(intervalMs));
    return runVintel(args);
  });
}

/**
 * Single-video CLIP moment search — "find the shot that looks like X".
 * @param {string} source
 * @param {string} query
 * @param {{topK?: number, minScore?: number}} [opts]
 * @returns {Promise<{hits: Array<{t_ms:number,score:number}>}|null>}
 */
export async function search(source, query, { topK = 10, minScore = 0.2 } = {}) {
  return tryVintel("search", async () => {
    const args = [
      "search",
      source,
      query,
      "--top-k", String(topK),
      "--min-score", String(minScore),
    ];
    return runVintel(args);
  });
}

/**
 * Fused timeline: transcript + visual captions + on-screen text + scenes.
 * @param {string} source
 * @param {{language?: string}} [opts]
 * @returns {Promise<object|null>}
 */
export async function observe(source, { language } = {}) {
  return tryVintel("observe", async () => {
    const args = ["observe", source, "--format", "json"];
    if (language) args.push("--language", language);
    return runVintel(args);
  });
}

/**
 * Build/refresh a cross-video corpus for `vintel search "<query>"` (no
 * source arg) to run against later.
 * @param {string} dir
 * @param {{recursive?: boolean}} [opts]
 * @returns {Promise<{dir:string,total:number,videos:object[]}|null>}
 */
export async function index(dir, { recursive = true } = {}) {
  return tryVintel("index", async () => {
    const args = ["index", dir];
    if (!recursive) args.push("--no-recursive");
    return runVintel(args);
  });
}
