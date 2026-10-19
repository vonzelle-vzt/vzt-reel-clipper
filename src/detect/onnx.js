import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, FFMPEG } from "../util.js";

/**
 * Local subject detector — YOLOv8 (or compatible single-output ONNX export) run
 * through onnxruntime-node. Pure Node, no Python, no cloud, no paid API: this is
 * the default `--fit smart` backend and keeps the project's "runs on your
 * machine" promise.
 *
 * Pixels come from ffmpeg as raw, letterboxed RGB (we already depend on ffmpeg),
 * so there is NO image-decoding library to install — only onnxruntime-node and a
 * model file. Both are loaded lazily; if either is missing the detector throws
 * and planReframe falls back to center `cover`.
 *
 * The decode/letterbox/NMS math is exported separately so it can be unit-tested
 * without the native runtime or a model.
 */

const NET = 640; // YOLOv8 default square input
const PERSON_CLASS = 0; // COCO 'person'

// Map source (w,h) onto a NET×NET square with aspect preserved (the transform
// YOLO's letterbox does); used to invert detections back to source pixels.
export function letterbox(w, h, net = NET) {
  const scale = Math.min(net / w, net / h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);
  const padX = Math.floor((net - newW) / 2);
  const padY = Math.floor((net - newH) / 2);
  return { scale, newW, newH, padX, padY };
}

/**
 * Decode a YOLOv8 detection head output into boxes in SOURCE pixel space.
 * @param data  Float32Array, flat
 * @param dims  [1, C, N] where C = 4 (cx,cy,w,h) + numClasses, N = anchors
 * @param lb    letterbox params from letterbox()
 */
export function decodeYolo(data, dims, lb, { confThres = 0.35, classes = [PERSON_CLASS] } = {}) {
  const [, C, N] = dims;
  const numCls = C - 4;
  const want = new Set(classes);
  const boxes = [];
  for (let n = 0; n < N; n++) {
    let bestC = -1;
    let bestS = 0;
    for (let c = 0; c < numCls; c++) {
      const s = data[(4 + c) * N + n];
      if (s > bestS) {
        bestS = s;
        bestC = c;
      }
    }
    if (bestS < confThres || !want.has(bestC)) continue;
    const cx = data[0 * N + n];
    const cy = data[1 * N + n];
    const bw = data[2 * N + n];
    const bh = data[3 * N + n];
    // undo the letterbox: net-space → source-space
    const x = (cx - bw / 2 - lb.padX) / lb.scale;
    const y = (cy - bh / 2 - lb.padY) / lb.scale;
    const w = bw / lb.scale;
    const h = bh / lb.scale;
    boxes.push({ x, y, w, h, score: bestS, cls: bestC === PERSON_CLASS ? "person" : `class${bestC}` });
  }
  return boxes;
}

export function nms(boxes, iouThres = 0.5) {
  const iou = (a, b) => {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = Math.max(0, x2 - x1);
    const ih = Math.max(0, y2 - y1);
    const inter = iw * ih;
    const uni = a.w * a.h + b.w * b.h - inter;
    return uni <= 0 ? 0 : inter / uni;
  };
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of sorted) {
    if (keep.every((k) => iou(k, b) < iouThres)) keep.push(b);
  }
  return keep;
}

// Pull N raw RGB frames (letterboxed to NET×NET, gray padding) for the clip at
// the given fps, in one ffmpeg pass. Returns a Buffer of count*NET*NET*3 bytes.
async function extractRawFrames(source, clip, fps, dir) {
  const dur = Math.max(0.1, clip.end - clip.start);
  const vf =
    `fps=${fps},` +
    `scale=${NET}:${NET}:force_original_aspect_ratio=decrease,` +
    `pad=${NET}:${NET}:(ow-iw)/2:(oh-ih)/2:color=0x727272,` + // 114,114,114 (YOLO pad)
    `format=rgb24`;
  await exec(
    FFMPEG,
    ["-y", "-ss", clip.start.toFixed(3), "-i", source, "-t", dur.toFixed(3), "-vf", vf, "-pix_fmt", "rgb24", "-f", "rawvideo", "out.rgb"],
    { cwd: dir, check: true },
  );
  return readFileSync(join(dir, "out.rgb"));
}

/**
 * Build a detect(frames, ctx) function backed by a local ONNX model.
 * Lazy: nothing is loaded until the first detect() call.
 */
export function createOnnxDetector({ modelPath, confThres = 0.35, classes = [PERSON_CLASS] } = {}) {
  let sessionPromise = null;
  async function getSession() {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        let ort;
        try {
          ort = await import("onnxruntime-node");
        } catch {
          throw new Error("onnxruntime-node not installed (run: npm i onnxruntime-node)");
        }
        const mp = modelPath || process.env.VZT_REFRAME_MODEL;
        if (!mp) throw new Error("no YOLO model — pass --reframe-model <path> or set VZT_REFRAME_MODEL");
        if (!existsSync(mp)) throw new Error(`reframe model not found at ${mp}`);
        const session = await ort.InferenceSession.create(mp);
        return { ort, session };
      })();
    }
    return sessionPromise;
  }

  return async function detect(frames, ctx) {
    const { w, h, source, clip, fps } = ctx;
    const { ort, session } = await getSession();
    const lb = letterbox(w, h);
    const dir = mkdtempSync(join(tmpdir(), "vzt-reframe-onnx-"));
    try {
      const buf = await extractRawFrames(source, clip, fps, dir);
      const frameSize = NET * NET * 3;
      const count = Math.min(Math.floor(buf.length / frameSize), frames.length);
      const inName = session.inputNames[0];
      const outName = session.outputNames[0];
      const results = [];
      for (let i = 0; i < count; i++) {
        const base = i * frameSize;
        // HWC uint8 → CHW float32 normalized [0,1]
        const input = new Float32Array(3 * NET * NET);
        const plane = NET * NET;
        for (let p = 0; p < plane; p++) {
          input[p] = buf[base + p * 3] / 255;
          input[plane + p] = buf[base + p * 3 + 1] / 255;
          input[2 * plane + p] = buf[base + p * 3 + 2] / 255;
        }
        const tensor = new ort.Tensor("float32", input, [1, 3, NET, NET]);
        const out = await session.run({ [inName]: tensor });
        const o = out[outName];
        const boxes = nms(decodeYolo(o.data, o.dims, lb, { confThres, classes }));
        results.push({ frameIdx: i, boxes });
      }
      return results;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
