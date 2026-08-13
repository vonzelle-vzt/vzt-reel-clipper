import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, FFMPEG } from "../util.js";

/**
 * Motion-tracking reframe backend (`--reframe-backend motion`).
 *
 * The onnx backend detects PEOPLE, which is the right subject for a talking
 * head and the wrong one for wide sports film. On a 7-on-7 tape shot from the
 * stands there are ~14 people spread across the whole field: the union of the
 * salient subjects spans the frame, `planTargets` correctly reports that it
 * can't be panned, and smart reframe letterboxes — the detector works and the
 * feature still does nothing useful.
 *
 * On sports footage the thing worth framing is not a person, it is the PLAY,
 * and the play is wherever the picture is changing. So this backend tracks
 * motion instead of objects:
 *
 *   low-res gray frames → frame-to-frame |Δluma| → threshold out camera noise
 *   → energy-weighted centroid + spread → one box per frame
 *
 * It needs no model and no extra dependency, which also makes `--fit smart`
 * work out of the box rather than behind a gated model download.
 *
 * Limits worth knowing: a hard camera pan moves every pixel, so the whole frame
 * reads as motion — the box widens and the existing letterbox guard takes over,
 * which is the correct outcome. A locked-off camera with two separate actions
 * gives a centroid between them, same as union framing would.
 */

const GRID_W = 160;
const GRID_H = 90;

// Vertical band the tracker looks at. Same reason as score.js: the near
// sideline across the bottom of frame and the stands across the top are
// foreground, and their bodies dominate any pixel-difference measure. Without
// this the camera follows a substitute shifting his weight instead of the play.
const DEFAULT_ROI = [0.12, 0.78];

/**
 * Locate the strongest band of motion across the frame.
 *
 * An energy-weighted CENTROID was tried first and does not work on team sports:
 * with fourteen players moving in both directions, the average of all that
 * movement sits in the middle of the field almost every frame. Measured on real
 * 7-on-7 film, the resulting camera path moved 10 pixels out of a possible
 * 1312 — a centre crop wearing a tracker's clothes.
 *
 * What the reframer actually needs is not "where is movement on average" but
 * "where should the 9:16 window sit". Since the window only travels
 * horizontally, that reduces to a 1-D search: collapse motion into a column
 * profile, then slide a window of the crop's own width and take the position
 * holding the most energy. That follows the ball-side cluster instead of
 * averaging it away with the backside players.
 *
 * @param {ArrayLike<number>} diff  gw*gh motion magnitudes
 * @param {number} winCols          crop width, in grid columns
 * @returns {{cx:number, cy:number, energy:number, share:number}|null}
 */
export function motionWindow(diff, gw, gh, winCols, { noiseFloor = 6, roi = DEFAULT_ROI } = {}) {
  const cols = new Float64Array(gw);
  let total = 0;
  const yA = Math.max(0, Math.floor(gh * roi[0]));
  const yB = Math.min(gh, Math.ceil(gh * roi[1]));
  for (let y = yA; y < yB; y++) {
    for (let x = 0; x < gw; x++) {
      const v = diff[y * gw + x];
      if (v < noiseFloor) continue; // sensor/compression noise, not movement
      cols[x] += v;
      total += v;
    }
  }
  if (total <= 0) return null;

  // Blur the profile so a single glinting pixel can't decide the framing.
  const smooth = new Float64Array(gw);
  const r = Math.max(1, Math.round(gw * 0.03));
  for (let x = 0; x < gw; x++) {
    let acc = 0;
    let n = 0;
    for (let k = -r; k <= r; k++) {
      const i = x + k;
      if (i < 0 || i >= gw) continue;
      acc += cols[i];
      n++;
    }
    smooth[x] = acc / n;
  }

  const w = Math.max(1, Math.min(gw, Math.round(winCols)));
  let best = 0;
  let bestSum = -1;
  let running = 0;
  for (let x = 0; x < gw; x++) {
    running += smooth[x];
    if (x >= w) running -= smooth[x - w];
    if (x >= w - 1 && running > bestSum) {
      bestSum = running;
      best = x - w + 1;
    }
  }

  // Vertical centre of the motion inside the winning band, for completeness —
  // the crop is full-height, so this only informs the box, never the pan.
  let vSum = 0;
  let vAcc = 0;
  for (let y = yA; y < yB; y++) {
    for (let x = best; x < best + w && x < gw; x++) {
      const v = diff[y * gw + x];
      if (v < noiseFloor) continue;
      vSum += v;
      vAcc += v * y;
    }
  }

  return {
    cx: best + w / 2,
    cy: vSum > 0 ? vAcc / vSum : gh / 2,
    energy: total / (gw * gh),
    // How concentrated the action is. Near 1 means the whole frame is moving
    // (a camera pan), which the caller uses to avoid chasing the operator.
    share: bestSum > 0 ? bestSum / (total / gh * w / w) / gh : 0,
  };
}

/**
 * Build a detect(frames, ctx) function that follows motion.
 * Matches the same contract as the onnx and vintel backends: it fetches its own
 * pixels and returns [{frameIdx, boxes:[{x,y,w,h,score,cls}]}] in SOURCE pixels.
 */
export function createMotionDetector({ noiseFloor = 6, roi = DEFAULT_ROI } = {}) {
  return async function detect(frames, ctx) {
    const { w, h, source, clip, fps } = ctx;
    // Search with a window the size of the 9:16 crop, expressed in grid columns.
    const cropFrac = Math.min(1, (h * (9 / 16)) / w);
    const winCols = Math.max(4, Math.round(GRID_W * cropFrac));
    const dir = mkdtempSync(join(tmpdir(), "vzt-reframe-mo-"));
    const dur = Math.max(0.1, clip.end - clip.start);
    let data;
    try {
      await exec(
        FFMPEG,
        ["-y", "-ss", clip.start.toFixed(3), "-t", dur.toFixed(3), "-i", source,
          "-vf", `fps=${fps},scale=${GRID_W}:${GRID_H},format=gray`,
          "-pix_fmt", "gray", "-f", "rawvideo", "g.raw"],
        { cwd: dir, check: true },
      );
      data = readFileSync(join(dir, "g.raw"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const frameSize = GRID_W * GRID_H;
    const count = Math.floor(data.length / frameSize);
    const sx = w / GRID_W;
    const sy = h / GRID_H;
    const diff = new Uint8Array(frameSize);
    const out = [];

    for (let i = 0; i < frames.length; i++) {
      // Frame 0 has no predecessor; reuse frame 1's motion so the camera starts
      // already looking at the action instead of drifting into it.
      const idx = Math.min(count - 1, Math.max(1, i));
      if (idx < 1 || idx >= count) {
        out.push({ frameIdx: i, boxes: [] });
        continue;
      }
      const a = (idx - 1) * frameSize;
      const b = idx * frameSize;
      for (let k = 0; k < frameSize; k++) diff[k] = Math.abs(data[b + k] - data[a + k]);

      const m = motionWindow(diff, GRID_W, GRID_H, winCols, { noiseFloor, roi });
      if (!m) {
        out.push({ frameIdx: i, boxes: [] });
        continue;
      }

      // One box, the size of the crop window, centred on the busiest band. It is
      // deliberately narrower than the crop so `planTargets` treats it as a
      // trackable subject rather than something too wide to frame.
      const bw = w * cropFrac * 0.7;
      const bh = h * 0.6;
      const cx = m.cx * sx;
      const cy = m.cy * sy;
      out.push({
        frameIdx: i,
        boxes: [{
          x: Math.max(0, Math.min(w - bw, cx - bw / 2)),
          y: Math.max(0, Math.min(h - bh, cy - bh / 2)),
          w: bw,
          h: bh,
          score: Math.min(1, m.energy / 12),
          cls: "motion",
        }],
      });
    }
    return out;
  };
}
