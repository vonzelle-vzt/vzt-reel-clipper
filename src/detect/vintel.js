import { exec } from "../util.js";

/**
 * Optional cloud subject detector — reuses the sibling `vintel` CLI's `entities`
 * command (Meta SAM2 on Replicate) to get tracked person boxes. Unlike the onnx
 * backend this is NOT local and NOT free: it needs a Replicate token configured
 * in vintel and bills per minute. It exists for users who already run vintel in
 * cloud mode and want its tracking quality; the default stays onnx.
 *
 * vintel emits Entity[] where each appearance carries sparse, time-stamped boxes:
 *   { tracking_id, label, confidence, appearances:[{ start_ms, end_ms,
 *      bboxes:[{ t_ms, bbox:[x,y,w,h] }] }] }   (bbox in absolute source pixels)
 */

// Slice the first JSON array out of mixed CLI stdout (mirrors transcribe.js).
function extractJsonArray(stdout) {
  const a = stdout.indexOf("[");
  const b = stdout.lastIndexOf("]");
  if (a < 0 || b < 0 || b < a) throw new Error("no JSON array in vintel output");
  return JSON.parse(stdout.slice(a, b + 1));
}

/**
 * Map vintel entities onto our per-frame box list. Boxes are sparse (~500ms),
 * so each frame collects every sample within `tolSec`; planCenters' hold/fill
 * then bridges the gaps.
 * @param entities Entity[]
 * @param frames   [{frameIdx, t}]  (t relative to clip start, seconds)
 * @param clip     {start, end}
 */
export function mapEntitiesToFrames(entities, frames, clip, tolSec = 0.35) {
  const samples = [];
  for (const e of entities || []) {
    for (const ap of e.appearances || []) {
      for (const bb of ap.bboxes || []) {
        if (!Array.isArray(bb.bbox) || bb.bbox.length < 4) continue;
        samples.push({
          tRel: bb.t_ms / 1000 - clip.start,
          bbox: bb.bbox,
          label: e.label || "object",
          conf: typeof e.confidence === "number" ? e.confidence : 0.85,
        });
      }
    }
  }
  return frames.map((f) => {
    const boxes = samples
      .filter((s) => Math.abs(s.tRel - f.t) <= tolSec)
      .map((s) => ({
        x: s.bbox[0],
        y: s.bbox[1],
        w: s.bbox[2],
        h: s.bbox[3],
        score: s.conf,
        cls: s.label === "person" ? "person" : s.label,
      }));
    return { frameIdx: f.frameIdx, boxes };
  });
}

export function createVintelDetector({ prompt = "person" } = {}) {
  return async function detect(frames, ctx) {
    const { source, clip } = ctx;
    const startMs = Math.round(clip.start * 1000);
    const endMs = Math.round(clip.end * 1000);
    const { stdout, code, stderr } = await exec(
      "vintel",
      ["entities", source, "--prompt", prompt, "--start-ms", String(startMs), "--end-ms", String(endMs)],
      { shell: process.platform === "win32" },
    );
    if (code !== 0) {
      throw new Error(`vintel entities failed (exit ${code}): ${stderr.slice(-200)}`);
    }
    const entities = extractJsonArray(stdout);
    if (!Array.isArray(entities) || !entities.length) {
      throw new Error("vintel returned no entities (needs a Replicate token and a visible subject)");
    }
    return mapEntitiesToFrames(entities, frames, clip);
  };
}
