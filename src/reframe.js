import { writeFileSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { exec, log, FFMPEG, FFPROBE } from "./util.js";
import { loudnessCurve } from "./sports.js";
import { createOnnxDetector } from "./detect/onnx.js";
import { createVintelDetector } from "./detect/vintel.js";

/**
 * Smart reframe — subject-tracking pan & scan for `--fit smart`.
 *
 * Turns a wide (16:9) source into a 9:16 vertical clip by cropping a tall,
 * full-height window and SLIDING it to keep the salient subject(s) in frame,
 * instead of the fixed center crop `cover` does.
 *
 * This module is pure planning: it produces a *camera path* (crop-left-edge x
 * over time) as data; `render.js` drives ffmpeg's `crop` via `sendcmd`. The
 * detector is pluggable (onnx local / vintel cloud / mock) so the tracker,
 * smoother and framing logic stay backend-agnostic.
 *
 * Quality behaviours:
 *  - Multi-subject UNION framing — centers between salient people when they fit.
 *  - Auto LETTERBOX — when subjects can't fit the 9:16 window across the clip,
 *    recommends rendering the whole clip as blur/contain instead of cropping
 *    someone out (single-pass-safe; the caller switches `--fit`).
 *  - Per-scene CUT SNAP — the camera hard-resets at edits (no pan across a cut).
 *  - Audio-aware HOLD — reuses ebur128 loudness to freeze the camera during
 *    silence so it doesn't drift/chase on pauses.
 *
 * If anything is missing or the source can't be panned, planReframe returns null
 * and the caller falls back to center `cover` — smart is never worse.
 */

const TARGET_W = 1080;
const TARGET_H = 1920;
const TARGET_AR = TARGET_W / TARGET_H; // 0.5625 (portrait 9:16)
const VERSION = 2; // bump invalidates cached paths (Phase 3 changed the algorithm)

const cX = (b) => b.x + b.w / 2;
const cY = (b) => b.y + b.h / 2;
const areaOf = (b) => Math.max(0, b.w) * Math.max(0, b.h);

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// --------------------------------------------------------------- geometry

async function sourceDims(source) {
  const { stdout } = await exec(
    FFPROBE,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", source],
    { check: true },
  );
  const [w, h] = stdout.trim().split(",").map(Number);
  if (!w || !h) throw new Error("could not read source dimensions");
  return { w, h };
}

// The 9:16 window we slide across the source: full height, AR-matched width.
// Returns null when the source isn't landscape enough to gain from panning.
function cropWindow(geom) {
  const ar = geom.w / geom.h;
  if (ar <= TARGET_AR + 1e-3) return null;
  let cropW = Math.round(geom.h * TARGET_AR);
  let cropH = geom.h;
  if (cropW < 16 || cropW >= geom.w) return null;
  if (cropW % 2) cropW += 1; // libx264/yuv420p needs even dims
  if (cropH % 2) cropH -= 1;
  return { cropW, cropH };
}

// --------------------------------------------------------------- sampling

// Frame descriptors are time-only: each backend fetches its own pixels.
function frameTimes(clip, fps) {
  const n = Math.max(1, Math.round((clip.end - clip.start) * fps));
  return Array.from({ length: n }, (_, i) => ({ frameIdx: i, t: +(i / fps).toFixed(3) }));
}

// Cut times (relative to clip start) via ffmpeg's scene-change score. Used to
// hard-reset the camera at edits. Best-effort: returns [].
async function detectSceneCuts(source, clip, threshold = 0.3) {
  const dur = Math.max(0.1, clip.end - clip.start);
  const dir = mkdtempSync(join(tmpdir(), "vzt-reframe-sc-"));
  const fname = "sc.txt";
  try {
    await exec(
      FFMPEG,
      ["-y", "-ss", clip.start.toFixed(3), "-i", source, "-t", dur.toFixed(3),
        "-vf", `select='gt(scene\\,${threshold})',metadata=print:file=${fname}`, "-an", "-f", "null", "-"],
      { cwd: dir, check: true },
    );
    const txt = readFileSync(join(dir, fname), "utf8");
    const cuts = [];
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/pts_time:([-\d.]+)/);
      if (m) cuts.push(parseFloat(m[1]));
    }
    return cuts;
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- backends

// Built-in synthetic detector (`--reframe-backend mock`): one subject panning
// left→right. No models; used to preview camera motion and in tests.
function builtinMockDetector(frames, ctx) {
  const { w, h } = ctx;
  return frames.map((f, i) => {
    const frac = frames.length > 1 ? i / (frames.length - 1) : 0.5;
    const bw = h * 0.45;
    const bh = h * 0.75;
    const cx = w * 0.18 + frac * (w * 0.64);
    const cy = h * 0.5;
    return { frameIdx: i, boxes: [{ x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, score: 0.9, cls: "person" }] };
  });
}

// Detectors are LAZY — they load runtime/model only on first call — so an
// unavailable backend throws inside detect() (caught → center cover), not here.
function resolveBackend(name, opts = {}) {
  if (name === "mock") return builtinMockDetector;
  if (name === "onnx") return createOnnxDetector({ modelPath: opts.modelPath, confThres: opts.confThres });
  if (name === "vintel") return createVintelDetector({ prompt: opts.prompt });
  if (name === "python") {
    return async () => {
      throw new Error("reframe backend 'python' not wired yet — use onnx (local) or vintel (cloud)");
    };
  }
  throw new Error(`unknown reframe backend '${name}' (use onnx|vintel|mock|python)`);
}

function normalizeBoxes(detected, n) {
  const out = Array.from({ length: n }, () => ({ boxes: [] }));
  if (!Array.isArray(detected)) return out;
  detected.forEach((d, i) => {
    const idx = d && Number.isInteger(d.frameIdx) ? d.frameIdx : i;
    if (idx >= 0 && idx < n) out[idx] = { boxes: Array.isArray(d?.boxes) ? d.boxes : [] };
  });
  return out;
}

// --------------------------------------------------------------- tracking

function segmentsFromCuts(frames, cuts) {
  const ct = [...(cuts || [])].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  let ci = 0;
  let seg = 0;
  return frames.map((f) => {
    while (ci < ct.length && f.t >= ct[ci]) {
      seg++;
      ci++;
    }
    return seg;
  });
}

// Greedy nearest-center tracker over one scene segment. Keeps EVERY track (with
// its per-frame box) so we can frame on the union of salient subjects.
function buildTracks(segBoxes, geom) {
  const tracks = [];
  const matchDist = geom.w * 0.2;
  segBoxes.forEach((boxes, fi) => {
    const used = new Set();
    for (const tr of tracks) {
      let best = -1;
      let bestD = Infinity;
      boxes.forEach((b, bi) => {
        if (used.has(bi)) return;
        const d = Math.hypot(cX(b) - tr.cx, cY(b) - tr.cy);
        if (d < bestD) {
          bestD = d;
          best = bi;
        }
      });
      if (best >= 0 && bestD <= matchDist) {
        const b = boxes[best];
        used.add(best);
        tr.cx = cX(b);
        tr.cy = cY(b);
        tr.count++;
        tr.area += areaOf(b);
        if (b.cls === "face") tr.face++;
        tr.box[fi] = b;
      }
    }
    boxes.forEach((b, bi) => {
      if (used.has(bi)) return;
      const tr = { cx: cX(b), cy: cY(b), count: 1, area: areaOf(b), face: b.cls === "face" ? 1 : 0, box: {} };
      tr.box[fi] = b;
      tracks.push(tr);
    });
  });
  return tracks;
}

/**
 * Per-frame framing targets. Within each scene segment, follow the UNION of the
 * salient subjects (the dominant track plus any comparably-sized track), so two
 * people get framed between them. Records the union WIDTH so the caller can
 * decide a clip can't be panned and should be letterboxed instead.
 * @returns {{centers:number[], widths:number[], segIds:number[], anySubject:boolean}}
 */
export function planTargets(frames, boxesByFrame, cuts, geom, { unionAreaFrac = 0.5 } = {}) {
  const segIds = segmentsFromCuts(frames, cuts);
  const centers = new Array(frames.length).fill(null);
  const widths = new Array(frames.length).fill(0);
  let anySubject = false;

  const bySeg = new Map();
  segIds.forEach((s, i) => {
    if (!bySeg.has(s)) bySeg.set(s, []);
    bySeg.get(s).push(i);
  });

  for (const [, idxs] of bySeg) {
    const segBoxes = idxs.map((i) => boxesByFrame[i]?.boxes || []);
    const tracks = buildTracks(segBoxes, geom);
    if (!tracks.length) continue;
    anySubject = true;

    const meanArea = (t) => t.area / t.count;
    const score = (t) => meanArea(t) + (t.face > 0 ? 1e9 : 0); // faces strongly preferred
    const dominant = tracks.reduce((a, b) => (score(b) > score(a) ? b : a));
    const domArea = meanArea(dominant);
    const salient = tracks.filter((t) => t === dominant || meanArea(t) >= unionAreaFrac * domArea);

    idxs.forEach((gi, li) => {
      let minx = Infinity;
      let maxx = -Infinity;
      let has = false;
      for (const t of salient) {
        const b = t.box[li];
        if (!b) continue;
        has = true;
        minx = Math.min(minx, b.x);
        maxx = Math.max(maxx, b.x + b.w);
      }
      if (has) {
        centers[gi] = (minx + maxx) / 2;
        widths[gi] = maxx - minx;
      }
    });

    // bridge detection gaps inside the segment (forward then backward fill)
    let prev = null;
    for (const gi of idxs) {
      if (centers[gi] != null) prev = centers[gi];
      else if (prev != null) centers[gi] = prev;
    }
    let nxt = null;
    for (let k = idxs.length - 1; k >= 0; k--) {
      const gi = idxs[k];
      if (centers[gi] != null) nxt = centers[gi];
      else if (nxt != null) centers[gi] = nxt;
    }
  }

  for (let i = 0; i < centers.length; i++) if (centers[i] == null) centers[i] = geom.w / 2;
  return { centers, widths, segIds, anySubject };
}

// --------------------------------------------------------------- smoothing

/**
 * Critically-damped follow with a deadzone and max-velocity clamp so the camera
 * glides like an operator. Resets at every scene cut (no pan across cuts). When
 * `gate[i]` is false (silence) the follow is damped so the camera holds still.
 */
export function smoothCenters(centers, segIds, geom, crop, { smooth, deadzone, fps, gate = null, quietDamp = 0.2 }) {
  const half = crop.cropW / 2;
  const minCx = half;
  const maxCx = geom.w - half;
  const alpha = Math.min(1, Math.max(0.05, 1 - smooth)); // higher smooth → slower follow
  const maxVel = (geom.w * 0.6) / fps; // px per sample (≤60% of width / second)
  const out = new Array(centers.length);
  let cur = null;
  let curSeg = null;
  for (let i = 0; i < centers.length; i++) {
    if (segIds[i] !== curSeg) {
      curSeg = segIds[i];
      cur = centers[i]; // hard cut → snap to the new subject
    }
    let a = alpha;
    if (gate && gate[i] === false) a *= quietDamp; // hold during silence
    let target = centers[i];
    if (Math.abs(target - cur) < deadzone) target = cur;
    let next = cur + a * (target - cur);
    const dv = next - cur;
    if (Math.abs(dv) > maxVel) next = cur + Math.sign(dv) * maxVel;
    next = Math.min(maxCx, Math.max(minCx, next));
    out[i] = next;
    cur = next;
  }
  return out;
}

function interpAt(ts, ys, t) {
  if (t <= ts[0]) return ys[0];
  if (t >= ts[ts.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < ts.length; i++) {
    if (t <= ts[i]) {
      const span = ts[i] - ts[i - 1] || 1;
      const f = (t - ts[i - 1]) / span;
      return ys[i - 1] + f * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}

/**
 * Densify the per-sample center path to ~outFps and emit crop-left-edge (x)
 * keyframes. Densification happens PER scene segment, so the camera hard-steps
 * at a cut instead of smearing across it. Consecutive duplicate x are dropped.
 */
export function buildKeyframes(cxPerFrame, frames, segIds, crop, geom, outFps = 15) {
  const half = crop.cropW / 2;
  const minX = 0;
  const maxX = Math.max(0, geom.w - crop.cropW);
  const clampX = (cx) => Math.round(Math.min(maxX, Math.max(minX, cx - half)));
  const step = 1 / outFps;
  const kf = [];
  let lastX = null;
  const push = (t, x) => {
    if (lastX === null || x !== lastX) {
      kf.push({ t: +t.toFixed(3), x });
      lastX = x;
    }
  };

  let i = 0;
  while (i < frames.length) {
    let j = i;
    while (j + 1 < frames.length && segIds[j + 1] === segIds[i]) j++;
    const ts = [];
    const ys = [];
    for (let k = i; k <= j; k++) {
      ts.push(frames[k].t);
      ys.push(cxPerFrame[k]);
    }
    const t0 = ts[0];
    const t1 = ts[ts.length - 1];
    if (t1 === t0) {
      push(t0, clampX(ys[0]));
    } else {
      for (let t = t0; t <= t1 + 1e-6; t += step) push(t, clampX(interpAt(ts, ys, t)));
    }
    i = j + 1;
  }
  if (!kf.length) kf.push({ t: 0, x: clampX(cxPerFrame[0]) });
  return kf;
}

// --------------------------------------------------------------- audio gate

// Per-frame speech-active flags from the clip's loudness curve. Frames quieter
// than typical (median − ½·scaled-MAD) are "silence" → camera holds. Returns
// null (no gating) when there's no usable audio.
async function computeGate(source, clip, frames, injected) {
  let series = injected;
  if (!series) {
    try {
      series = await loudnessCurve(source, { start: clip.start, end: clip.end });
    } catch {
      return null;
    }
  }
  if (!Array.isArray(series) || series.length < 3) return null;
  const Ms = series.map((s) => (Number.isFinite(s.M) ? s.M : -120));
  const med = median(Ms);
  const mad = median(Ms.map((x) => Math.abs(x - med))) || 1;
  const floor = med - 0.5 * 1.4826 * mad;
  const ts = series.map((s) => s.t);
  const ys = Ms;
  return frames.map((f) => interpAt(ts, ys, f.t) >= floor);
}

// --------------------------------------------------------------- cache

function cacheKey(source, clip, o) {
  let stat = "";
  try {
    const s = statSync(source);
    stat = `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    // unstatable (e.g. synthetic test source) — key on path alone
  }
  return createHash("sha1")
    .update(
      [source, stat, clip.start, clip.end, o.fps, o.backend, o.smooth, o.deadzone, o.modelPath || "", o.confThres ?? "", o.audioHold ? 1 : 0, o.letterboxFit || "", VERSION].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
}

// --------------------------------------------------------------- public

/**
 * Plan the smart-reframe outcome for one clip.
 * @returns {Promise<null
 *   | {keyframes:[{t,x}], cropW, cropH, sourceW, sourceH, backend, fps}      // pan
 *   | {recommendFit:'blur'|'contain'|'cover', reason:string, keyframes:[]}>} // letterbox
 *  null → caller uses the clip's configured fit (cover).
 */
export async function planReframe(source, clip, opts = {}) {
  const fps = opts.fps ?? 5;
  const backend = opts.backend ?? "onnx";
  const smooth = opts.smooth ?? 0.85;
  const deadzone = opts.deadzone ?? 24;
  const audioHold = opts.audioHold !== false;
  const letterboxFit = ["blur", "contain", "cover"].includes(opts.letterboxFit) ? opts.letterboxFit : "blur";
  const letterboxFrac = opts.letterboxFrac ?? 0.6;
  const workDir = opts.workDir || null;

  let detect;
  try {
    detect =
      opts.detect ||
      resolveBackend(backend, { modelPath: opts.modelPath, confThres: opts.confThres, prompt: opts.prompt });
  } catch (e) {
    log.warn(`smart reframe: ${e.message} — using center crop`);
    return null;
  }

  let geom;
  try {
    geom = opts.sourceDims || (await sourceDims(source));
  } catch (e) {
    log.warn(`smart reframe: ${e.message.split("\n")[0]} — using center crop`);
    return null;
  }

  const crop = cropWindow(geom);
  if (!crop) {
    log.warn(`smart reframe: source ${geom.w}x${geom.h} is not landscape enough to pan — using center crop`);
    return null;
  }

  const cachePath = workDir
    ? join(workDir, `reframe-${cacheKey(source, clip, { fps, backend, smooth, deadzone, modelPath: opts.modelPath, confThres: opts.confThres, audioHold, letterboxFit })}.json`)
    : null;
  if (cachePath && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (cached.version === VERSION) {
        log.info("smart reframe: using cached reframe plan");
        return cached;
      }
    } catch {
      // corrupt cache — recompute
    }
  }

  try {
    const frames = frameTimes(clip, fps);
    const cuts = opts.sceneCuts === false ? opts.cuts || [] : await detectSceneCuts(source, clip);

    const detected = await detect(frames, { ...geom, source, clip, fps });
    const boxesByFrame = normalizeBoxes(detected, frames.length);
    const { centers, widths, segIds, anySubject } = planTargets(frames, boxesByFrame, cuts, geom, {
      unionAreaFrac: opts.unionAreaFrac,
    });

    // Nothing to track → let the caller use its configured fit (cover).
    if (!anySubject) {
      log.info("smart reframe: no subject detected — using center crop");
      return null;
    }

    // Too wide to pan without cutting subjects → letterbox the whole clip.
    const widthsValid = widths.filter((w) => w > 0);
    const wideFrac = widthsValid.length ? widthsValid.filter((w) => w > crop.cropW).length / widthsValid.length : 0;
    if (wideFrac >= letterboxFrac) {
      const result = {
        version: VERSION,
        backend,
        fps,
        recommendFit: letterboxFit,
        reason: `wide multi-subject shot (${Math.round(wideFrac * 100)}% of frames exceed the 9:16 window)`,
        keyframes: [],
        cropW: crop.cropW,
        cropH: crop.cropH,
        sourceW: geom.w,
        sourceH: geom.h,
      };
      if (cachePath) {
        try {
          writeFileSync(cachePath, JSON.stringify(result));
        } catch {
          /* non-fatal */
        }
      }
      return result;
    }

    const gate = audioHold ? await computeGate(source, clip, frames, opts.loudness) : null;
    const smoothed = smoothCenters(centers, segIds, geom, crop, {
      smooth,
      deadzone,
      fps,
      gate,
      quietDamp: opts.quietDamp ?? 0.2,
    });
    const keyframes = buildKeyframes(smoothed, frames, segIds, crop, geom);

    const result = {
      version: VERSION,
      backend,
      fps,
      cropW: crop.cropW,
      cropH: crop.cropH,
      sourceW: geom.w,
      sourceH: geom.h,
      keyframes,
      fallback: null,
    };
    if (cachePath) {
      try {
        writeFileSync(cachePath, JSON.stringify(result));
      } catch {
        /* non-fatal */
      }
    }
    return result;
  } catch (e) {
    log.warn(`smart reframe: ${e.message.split("\n")[0]} — using center crop`);
    return null;
  }
}
