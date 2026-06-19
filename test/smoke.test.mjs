// Self-contained smoke tests — no network, no external fixtures.
// Generates a tiny synthetic video with ffmpeg and exercises the real pipeline.
//
//   npm test
//
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAss, buildTitleAss } from "../src/ass.js";
import { parseVtt } from "../src/transcribe.js";
import { selectSportsClips } from "../src/sports.js";
import { renderClip, stitchReel } from "../src/render.js";
import { planReframe, smoothCenters } from "../src/reframe.js";
import { letterbox, decodeYolo, nms } from "../src/detect/onnx.js";
import { mapEntitiesToFrames } from "../src/detect/vintel.js";
import { exec, ffprobeDuration, FFMPEG, FFPROBE } from "../src/util.js";

let passed = 0;
const ok = (name) => { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; };

const work = mkdtempSync(join(tmpdir(), "vzt-reel-test-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

// ---------------------------------------------------------------- unit: ASS
{
  const words = [
    { text: "hello", start: 0, end: 0.4 },
    { text: "world", start: 0.4, end: 0.9 },
  ];
  const ass = buildAss(words);
  const dlg = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(dlg.length, 2, "one Dialogue per word");
  // Field count: exactly 9 fields (8 commas) before the text begins.
  for (const line of dlg) {
    const body = line.replace(/^Dialogue:\s*/, "");
    const commasBeforeText = body.split(",", 9).slice(0, 8).join(",").length;
    const text = body.slice(commasBeforeText + 1);
    assert.ok(!text.startsWith(","), "no stray leading comma in caption text");
  }
  assert.ok(ass.includes("\\c&H0000F0FF"), "active word gets the highlight colour");
  ok("buildAss: per-word dialogues, correct fields, no leading comma");

  const title = buildTitleAss("Big Play 1", 9);
  assert.ok(title.includes("BIG PLAY 1"), "title is upper-cased");
  assert.ok(/Alignment.*\n.*,8,/s.test(title) || title.includes(",8,"), "title uses top-center alignment");
  ok("buildTitleAss: static top banner");
}

// ---------------------------------------------------------------- unit: VTT
{
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<00:00:01.000><c>the</c><00:00:01.500><c> quick</c><00:00:02.200><c> fox</c>
`;
  const { words } = parseVtt(vtt);
  assert.ok(words.length >= 3, "parses word-level tokens");
  assert.equal(words[0].text, "the");
  assert.ok(words[1].start >= 1.4 && words[1].start <= 1.6, "uses inline word timing");
  ok("parseVtt: word-level timing from YouTube auto-subs");
}

// ------------------------------------------- unit: detector helpers (Phase 2)
// Pure math — no ffmpeg/model — so these run even where libass is unavailable.
{
  // letterbox: 640x360 onto 640 net → fills width, pads top/bottom symmetrically.
  const lb = letterbox(640, 360, 640);
  assert.ok(Math.abs(lb.scale - 1) < 1e-9, "640-wide source maps 1:1 at net=640");
  assert.equal(lb.padX, 0, "no horizontal pad for a wide source");
  assert.ok(lb.padY > 0, "vertical letterbox padding added");

  // decodeYolo: a single person anchor at net-center should map back to a box
  // centered in the SOURCE (≈ 320,180 for a 640x360 source). Layout is [c*N+n].
  const N = 2; // two anchors; only the 2nd is a confident person
  const C = 5; // 4 bbox + 1 class (person)
  const data = new Float32Array(C * N);
  // anchor 1 (n=0): low score, ignored
  data[0 * N + 0] = 10; data[1 * N + 0] = 10; data[2 * N + 0] = 5; data[3 * N + 0] = 5; data[4 * N + 0] = 0.05;
  // anchor 2 (n=1): net-center box, high score
  data[0 * N + 1] = 320; data[1 * N + 1] = 320; data[2 * N + 1] = 200; data[3 * N + 1] = 300; data[4 * N + 1] = 0.9;
  const boxes = decodeYolo(data, [1, C, N], lb, { confThres: 0.35 });
  assert.equal(boxes.length, 1, "only the confident anchor survives the threshold");
  assert.equal(boxes[0].cls, "person", "class 0 decodes to 'person'");
  const bx = boxes[0];
  assert.ok(Math.abs(bx.x + bx.w / 2 - 320) < 2, "box re-centers on source x≈320");
  assert.ok(Math.abs(bx.y + bx.h / 2 - 180) < 2, "letterbox pad removed → source y≈180");
  ok("decodeYolo + letterbox: net detection maps back to source pixels");

  // nms: two near-identical boxes collapse to one; a disjoint box survives.
  const merged = nms(
    [
      { x: 0, y: 0, w: 100, h: 100, score: 0.9, cls: "person" },
      { x: 5, y: 5, w: 100, h: 100, score: 0.8, cls: "person" },
      { x: 400, y: 0, w: 100, h: 100, score: 0.7, cls: "person" },
    ],
    0.5,
  );
  assert.equal(merged.length, 2, "overlapping duplicates suppressed, disjoint kept");
  ok("nms: suppresses overlapping duplicate boxes");

  // mapEntitiesToFrames: vintel Entity[] → per-frame boxes by nearest time.
  const entities = [
    {
      tracking_id: "p1",
      label: "person",
      confidence: 0.93,
      appearances: [{ scene_id: 0, start_ms: 5000, end_ms: 7000, bboxes: [{ t_ms: 6000, bbox: [120, 88, 412, 720] }] }],
    },
  ];
  const frames = [
    { frameIdx: 0, t: 0.5 }, // → abs 5.5s, 0.5s from the sample (> 0.35 tol) → no box
    { frameIdx: 1, t: 1.0 }, // → abs 6.0s, matches the 6000ms box
  ];
  const mapped = mapEntitiesToFrames(entities, frames, { start: 5, end: 7 });
  assert.equal(mapped[0].boxes.length, 0, "frame far from any sample has no box");
  assert.equal(mapped[1].boxes.length, 1, "frame near t_ms picks up the person box");
  assert.deepEqual(
    [mapped[1].boxes[0].x, mapped[1].boxes[0].y, mapped[1].boxes[0].w, mapped[1].boxes[0].h],
    [120, 88, 412, 720],
    "bbox [x,y,w,h] passes through unchanged",
  );
  ok("mapEntitiesToFrames: vintel entities → per-frame boxes by time");
}

// ------------------------------------------- unit: reframe quality (Phase 3)
// All pure — sourceDims injected, sceneCuts/audio injected — so no ffmpeg/model.
{
  const geom = { w: 640, h: 360 };
  const cropW = 204; // 9:16 of 360, even
  const fps = 5;

  // (a) cut-snapping: subject jumps left→right at a scene cut → the path must
  // hard-step at the cut, with no interpolated intermediate frames across it.
  const cut = 2.0;
  const jumpDetect = (frames) =>
    frames.map((f, i) => {
      const cx = f.t < cut ? geom.w * 0.2 : geom.w * 0.8;
      const bw = geom.h * 0.4;
      return { frameIdx: i, boxes: [{ x: cx - bw / 2, y: geom.h * 0.15, w: bw, h: geom.h * 0.7, score: 0.9, cls: "person" }] };
    });
  const snap = await planReframe("x.mp4", { start: 0, end: 4 }, {
    detect: jumpDetect, sceneCuts: false, cuts: [cut], audioHold: false, fps, smooth: 0.6, deadzone: 4, sourceDims: geom,
  });
  const sx = snap.keyframes.map((k) => k.x);
  let maxStep = 0;
  for (let i = 1; i < sx.length; i++) maxStep = Math.max(maxStep, Math.abs(sx[i] - sx[i - 1]));
  assert.ok(maxStep > geom.w * 0.4, `hard cut produces a big single step (${maxStep}px)`);
  assert.ok(!sx.some((x) => x > 80 && x < 350), "no interpolated frames across the cut (true snap)");
  ok("buildKeyframes: camera hard-snaps at a scene cut");

  // (b) union framing: two subjects that fit are framed BETWEEN them (≈ center),
  // vs a single off-center subject which is framed ON it.
  const twoClose = (frames) =>
    frames.map((f, i) => {
      const bw = geom.h * 0.18;
      const mk = (cx) => ({ x: cx - bw / 2, y: geom.h * 0.2, w: bw, h: geom.h * 0.6, score: 0.9, cls: "person" });
      return { frameIdx: i, boxes: [mk(geom.w * 0.42), mk(geom.w * 0.58)] };
    });
  const oneLeft = (frames) =>
    frames.map((f, i) => {
      const bw = geom.h * 0.18;
      return { frameIdx: i, boxes: [{ x: geom.w * 0.42 - bw / 2, y: geom.h * 0.2, w: bw, h: geom.h * 0.6, score: 0.9, cls: "person" }] };
    });
  const u = await planReframe("x.mp4", { start: 0, end: 3 }, { detect: twoClose, sceneCuts: false, cuts: [], audioHold: false, fps, smooth: 0.3, deadzone: 0, sourceDims: geom });
  const s = await planReframe("x.mp4", { start: 0, end: 3 }, { detect: oneLeft, sceneCuts: false, cuts: [], audioHold: false, fps, smooth: 0.3, deadzone: 0, sourceDims: geom });
  const uMid = u.keyframes.at(-1).x;
  const sMid = s.keyframes.at(-1).x;
  assert.ok(uMid > sMid + 20, `two subjects frame more centered than one (union ${uMid} > single ${sMid})`);
  assert.ok(Math.abs(uMid - (geom.w / 2 - cropW / 2)) < 25, "union centers between the two subjects");
  ok("planTargets: union framing centers between salient subjects");

  // (c) auto-letterbox: two subjects too far apart to fit a 9:16 crop → no pan,
  // a clip-level recommendFit instead.
  const wide = { w: 1920, h: 1080 };
  const farApart = (frames) =>
    frames.map((f, i) => {
      const bw = wide.h * 0.15;
      const mk = (cx) => ({ x: cx - bw / 2, y: wide.h * 0.2, w: bw, h: wide.h * 0.6, score: 0.9, cls: "person" });
      return { frameIdx: i, boxes: [mk(wide.w * 0.15), mk(wide.w * 0.85)] };
    });
  const lb = await planReframe("x.mp4", { start: 0, end: 3 }, { detect: farApart, sceneCuts: false, cuts: [], audioHold: false, fps, sourceDims: wide, letterboxFit: "blur" });
  assert.equal(lb.recommendFit, "blur", "wide two-shot recommends a letterbox fit");
  assert.equal(lb.keyframes.length, 0, "letterbox recommendation carries no pan path");
  ok("planReframe: wide multi-subject clip auto-letterboxes");

  // (d) audio hold: with a moving target, a silent gate holds the camera far
  // more than an active gate (it follows much less).
  const N = 20;
  const moving = Array.from({ length: N }, (_, i) => (i / (N - 1)) * 600); // 0 → 600
  const segIds = new Array(N).fill(0);
  const crop = { cropW, cropH: 360 };
  const active = smoothCenters(moving, segIds, geom, crop, { smooth: 0.6, deadzone: 0, fps, gate: new Array(N).fill(true) });
  const silent = smoothCenters(moving, segIds, geom, crop, { smooth: 0.6, deadzone: 0, fps, gate: new Array(N).fill(false), quietDamp: 0.1 });
  assert.ok(active.at(-1) > silent.at(-1) + 40, `silence holds the camera (active ${active.at(-1).toFixed(0)} vs held ${silent.at(-1).toFixed(0)})`);
  ok("smoothCenters: audio gate holds the camera during silence");
}

// ------------------------------------------------------- integration: ffmpeg
const src = join(work, "game.mp4");
console.log("  … generating synthetic fixture (ffmpeg)");
await exec(FFMPEG, [
  "-y",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=60",
  "-f", "lavfi", "-i", "sine=frequency=200:duration=60",
  "-af", "volume=0.08,volume=enable='between(t,12,15)+between(t,38,41)':volume=14",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  src,
], { check: true });

{
  const clips = await selectSportsClips(src, { count: 5, preroll: 4, postroll: 3, sensitivity: 1.0 });
  assert.equal(clips.length, 2, "detects exactly the two engineered peaks (no padding)");
  const peaks = clips.map((c) => c.peak).sort((a, b) => a - b);
  assert.ok(Math.abs(peaks[0] - 13.5) < 4, `peak1 near 13.5s (got ${peaks[0]})`);
  assert.ok(Math.abs(peaks[1] - 39.5) < 4, `peak2 near 39.5s (got ${peaks[1]})`);
  ok("selectSportsClips: finds both peaks, drops non-events");

  const out1 = await renderClip(src, clips[0], [], work, "01-play", { staticTitle: clips[0].title });
  assert.ok(existsSync(out1), "clip rendered");
  const w = await exec(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", out1], { check: true });
  assert.equal(w.stdout.trim(), "1080,1920", "output is 1080x1920 vertical");
  ok("renderClip: 9:16 vertical output with title banner");

  const out2 = await renderClip(src, clips[1], [], work, "02-play", { staticTitle: clips[1].title });
  const reel = await stitchReel([out1, out2], work, "reel");
  assert.ok(existsSync(reel), "reel stitched");
  const dur = await ffprobeDuration(reel);
  assert.ok(dur > 10, `reel concatenates clips (got ${dur.toFixed(1)}s)`);
  ok("stitchReel: concatenates clips into one reel");
}

// ------------------------------------------------ integration: smart reframe
{
  // Inject a detector whose subject sweeps left→right across the frame; the
  // planned camera path should follow it (and stay smooth). sceneCuts:false
  // keeps the test fast and hermetic (no ffmpeg scene-detect pass).
  const detect = (frames, ctx) =>
    frames.map((f, i) => {
      const frac = frames.length > 1 ? i / (frames.length - 1) : 0.5;
      const bw = ctx.h * 0.4;
      const bh = ctx.h * 0.7;
      const cx = ctx.w * 0.15 + frac * (ctx.w * 0.7);
      return { frameIdx: i, boxes: [{ x: cx - bw / 2, y: ctx.h * 0.15, w: bw, h: bh, score: 0.9, cls: "person" }] };
    });

  const clip = { start: 5, end: 15, title: "Smart Pan" };
  const plan = await planReframe(src, clip, {
    detect,
    sceneCuts: false,
    audioHold: false,
    fps: 5,
    smooth: 0.6,
    deadzone: 6,
    sourceDims: { w: 640, h: 360 }, // matches the synthetic fixture (16:9)
  });
  assert.ok(plan && plan.keyframes.length > 2, "reframe produced a multi-point camera path");
  // 9:16 of the 360px source height = 202.5 → even-ized to 204; full height stays 360.
  assert.equal(plan.cropW, 204, "crop window width is 9:16 of source height (even)");
  assert.equal(plan.cropH, 360, "crop window is full source height");
  const xs = plan.keyframes.map((k) => k.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 20, "camera pans to follow the moving subject");
  assert.ok(xs[xs.length - 1] > xs[0], "camera ends right of where it started (subject moved right)");
  let maxStep = 0;
  for (let i = 1; i < xs.length; i++) maxStep = Math.max(maxStep, Math.abs(xs[i] - xs[i - 1]));
  assert.ok(maxStep < 640 * 0.6, `no teleport between keyframes (max step ${maxStep}px)`);
  ok("planReframe: smoothed camera path follows the subject");

  const smartOut = await renderClip(src, clip, [], work, "03-smart", { fit: "smart", reframe: plan });
  assert.ok(existsSync(smartOut), "smart clip rendered");
  const dim = await exec(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", smartOut], { check: true });
  assert.equal(dim.stdout.trim(), "1080,1920", "smart clip is 1080x1920 vertical");
  ok("renderClip(fit=smart): dynamic-crop render is valid 9:16");

  // Fallback contract: fit=smart with no usable path must degrade to cover, not crash.
  const fb = await renderClip(src, clip, [], work, "04-fallback", { fit: "smart", reframe: null });
  const fbDim = await exec(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", fb], { check: true });
  assert.equal(fbDim.stdout.trim(), "1080,1920", "fallback still produces 1080x1920");
  ok("renderClip(fit=smart, no path): falls back to center cover");
}

console.log(`\n\x1b[32m\x1b[1m${passed} tests passed\x1b[0m`);
