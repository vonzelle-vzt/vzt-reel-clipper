// Self-contained smoke tests — no network, no external fixtures.
// Generates a tiny synthetic video with ffmpeg and exercises the real pipeline.
//
//   npm test
//
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAss, buildTitleAss } from "../src/ass.js";
import { parseVtt } from "../src/transcribe.js";
import { selectSportsClips } from "../src/sports.js";
import { renderClip, stitchReel } from "../src/render.js";
import { planReframe, smoothCenters, selectActiveSpeaker, regionLuma } from "../src/reframe.js";
import { letterbox, decodeYolo, nms } from "../src/detect/onnx.js";
import { mapEntitiesToFrames } from "../src/detect/vintel.js";
import { exec, ffprobeDuration, FFMPEG, FFPROBE } from "../src/util.js";
import { analyzeMusic, snapToBeat, barSeconds } from "../src/music.js";
import { combine, looksDeadBall, percentile, suppress, scorePlays } from "../src/score.js";
import { planEdit, solveRamp } from "../src/plan.js";
import { renderReel, exportCover, transitionSpec } from "../src/composite.js";
import { motionWindow } from "../src/detect/motion.js";
import { labelFrames, labelMix, estimateTokens } from "../src/vision.js";
import { summarize, actionSpans, resolveDensity } from "../src/watch.js";
import { Command } from "commander";
import { deriveStyle, beatAlignment, fitArc, styleToPlanOpts, resolveRampCount } from "../src/learn/style.js";

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
  const lb = await planReframe("x.mp4", { start: 0, end: 3 }, { detect: farApart, sceneCuts: false, cuts: [], audioHold: false, activeSpeaker: false, fps, sourceDims: wide, letterboxFit: "blur" });
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

// --------------------------------------- unit: active speaker (Phase 4)
{
  const fps = 5;
  const N = 20;

  // (a) regionLuma: mouth region (upper part of the box) samples the bright top
  // half of the grid, not the dark bottom — confirms the vertical mapping.
  const geom = { w: 200, h: 200 };
  const gw = 20;
  const gh = 20;
  const data = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) data[y * gw + x] = y < gh / 2 ? 200 : 0;
  const luma = regionLuma({ data, gw, gh, count: 1 }, 0, geom, { x: 50, y: 0, w: 100, h: 200 });
  assert.ok(luma > 150, `mouth region reads the bright upper band (${luma.toFixed(0)})`);
  ok("regionLuma: samples the mouth region in grid space");

  // (b) selectActiveSpeaker: subject A moves (talks) in the first half, B in the
  // second — the camera should start on A, switch to B, once.
  const frames = Array.from({ length: N }, (_, i) => ({ frameIdx: i, t: i / fps }));
  const moving = frames.map((f, i) => [
    { id: "A", cx: 100, act: i < N / 2 ? 10 : 0 },
    { id: "B", cx: 500, act: i < N / 2 ? 0 : 10 },
  ]);
  const sel = selectActiveSpeaker(moving, frames, null, { fps, minDwellSec: 0.4, switchMargin: 1.5 });
  assert.ok(sel.confident, "clear mouth motion ⇒ confident");
  assert.equal(sel.centers[2], 100, "follows the talking subject A first");
  assert.equal(sel.centers[N - 1], 500, "switches to subject B when A goes quiet");
  assert.equal(sel.switchAt.filter(Boolean).length, 1, "exactly one speaker switch (hysteresis, no flicker)");
  ok("selectActiveSpeaker: follows the talker and switches once");

  // (c) no motion anywhere ⇒ not confident (caller will letterbox instead).
  const still = frames.map(() => [
    { id: "A", cx: 100, act: 0 },
    { id: "B", cx: 500, act: 0 },
  ]);
  const flat = selectActiveSpeaker(still, frames, null, { fps });
  assert.equal(flat.confident, false, "no mouth motion ⇒ not confident ⇒ letterbox");
  ok("selectActiveSpeaker: bails (lets caller letterbox) when no one is talking");
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

// ============================================================ hype mode
// Music-driven reel assembly. Every fixture below is synthesized with ffmpeg —
// no network, no checked-in media.

// ------------------------------------------------------------- unit: music
{
  console.log("  … analyzing synthetic click tracks");
  // A click track at a known tempo is the only honest oracle for beat
  // detection: we know the right answer to the millisecond.
  for (const bpm of [90, 120, 140]) {
    const period = (60 / bpm).toFixed(6);
    const wav = join(work, `click-${bpm}.wav`);
    await exec(FFMPEG, ["-y", "-f", "lavfi", "-i",
      `aevalsrc='0.8*sin(2*PI*1000*t)*exp(-40*mod(t,${period}))':s=44100:d=30`, wav], { check: true });

    const m = await analyzeMusic(wav);
    assert.ok(Math.abs(m.bpm - bpm) <= 2, `detected ${m.bpm} BPM, expected ~${bpm}`);
    // Drift matters more than the headline BPM: a period that is slightly off
    // accumulates, and by minute three every cut has slid off the beat.
    const ideal = 60 / bpm;
    const last = m.beats.length - 1;
    const drift = Math.abs(m.beats[last] - (m.beats[0] + last * ideal));
    assert.ok(drift <= 0.05, `beat grid drifted ${(drift * 1000).toFixed(0)}ms over ${m.beats.length} beats`);
    assert.ok(m.downbeats.length > 0, "downbeats derived");
  }
  ok("analyzeMusic: BPM within ±2 and a non-drifting beat grid (90/120/140)");

  assert.equal(snapToBeat(1.04, [0, 0.5, 1.0, 1.5]), 1.0, "snaps to the nearest beat");
  assert.ok(Math.abs(barSeconds(120) - 2) < 1e-9, "one bar of 4/4 at 120 BPM is 2s");
  ok("music helpers: snapToBeat / barSeconds");
}

// ------------------------------------------------------------- unit: score
{
  // A missing signal must redistribute its weight, not deflate the score —
  // otherwise silent phone film scores uniformly lower for no reason.
  const all = combine({ motion: 0.8, audio: 0.8, context: 0.8 });
  const noAudio = combine({ motion: 0.8, audio: null, context: 0.8 });
  assert.ok(Math.abs(all - noAudio) < 1e-9, "missing signal renormalizes weights");

  // The dead-ball tell is loud-but-still.
  assert.equal(looksDeadBall({ motion: 0.1, audio: 0.9 }), true, "loud + still is dead ball");
  assert.equal(looksDeadBall({ motion: 0.9, audio: 0.05 }), false, "silent + moving is live");
  // Critical for phone film with no crowd mic: quiet AND still must NOT be
  // rejected on audio grounds, or all silent action is thrown away.
  assert.equal(looksDeadBall({ motion: 0.1, audio: 0.05 }), false, "quiet + still is not rejected");
  // Bounds are inclusive: a static stretch is a plateau sitting exactly ON the
  // percentile threshold, and a strict comparison rejects none of it.
  assert.equal(looksDeadBall({ motion: 0.3, audio: 0.6 }), true, "threshold boundary is inclusive");
  ok("score: weight renormalization + dead-ball rules");

  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  const sup = suppress([{ t: 10, score: 1 }, { t: 11, score: 0.9 }, { t: 30, score: 0.8 }], 5);
  assert.equal(sup.length, 2, "suppresses a neighbour inside the gap");
  ok("score: percentile + non-maximum suppression");
}

// --------------------------------------------------- integration: scoring
{
  // Two halves: LOUD but motionless, then SILENT but moving. Audio-only
  // selection picks the wrong half; this is the case that motivated the
  // multi-signal scorer.
  console.log("  … generating loud-still / silent-action fixture");
  const still = join(work, "seg-still.mp4");
  const action = join(work, "seg-action.mp4");
  const phone = join(work, "phonefilm.mp4");
  await exec(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=navy:s=320x180:d=12,format=yuv420p",
    "-f", "lavfi", "-i", "sine=f=300:d=12", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", still], { check: true });
  await exec(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=s=320x180:d=12:r=30",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=12", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", action], { check: true });
  const listFile = join(work, "phone.txt");
  writeFileSync(listFile, `file '${still}'\nfile '${action}'\n`);
  await exec(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", phone], { check: true });

  const total = await ffprobeDuration(phone);
  const boundary = total / 2;
  const plays = await scorePlays(phone, { sport: "basketball", count: 3, useIntel: false, minGap: 5 });
  assert.ok(plays.length > 0, "found plays in the silent half");
  for (const p of plays) {
    assert.ok(p.peak >= boundary, `peak at ${p.peak.toFixed(1)}s should be in the moving half (>${boundary.toFixed(1)}s)`);
  }
  ok("scorePlays: picks silent ACTION over loud stillness (phone-film case)");
}

// ---------------------------------------------------------- unit: the EDL
{
  const bpm = 120;
  const per = 60 / bpm;
  const beats = Array.from({ length: 120 }, (_, i) => +(i * per).toFixed(4));
  const music = { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), drop: beats[8], duration: 60, path: "m.mp3" };
  const plays = Array.from({ length: 8 }, (_, i) => ({
    src: "g.mp4", start: 20 + i * 30, end: 31 + i * 30, peak: 25 + i * 30,
    score: 0.9 - i * 0.05, angle: ["A", "B", "C"][i % 3], title: `P${i}`,
  }));
  const broll = Array.from({ length: 8 }, (_, i) => ({
    src: "g.mp4", start: i * 5, end: i * 5 + 4, angle: ["X", "Y"][i % 2], label: `b${i}`,
  }));
  const edl = planEdit({
    music, plays, broll,
    outro: [{ src: "g.mp4", start: 200, end: 206, angle: "Z", label: "celeb" }],
    sport: "basketball", opts: { maxDuration: 45 },
  });

  // 1. Cuts land on the grid by construction, not by snapping.
  for (const s of edl.shots) {
    const off = Math.min(...beats.map((b) => Math.abs(b - s.at)));
    assert.ok(off <= 0.04, `shot at ${s.at} is ${(off * 1000).toFixed(0)}ms off the beat`);
  }
  // 2. Hook on the drop — the rule the old chronological sort broke.
  const hook = edl.shots.find((s) => s.hook);
  assert.ok(hook, "an explicit hook shot exists");
  assert.ok(Math.abs(hook.at - music.drop) <= per, "hook lands on the drop");
  assert.equal(hook.score, Math.max(...plays.map((p) => p.score)), "hook is the highest-scored play");
  // 3. No overlaps.
  for (let i = 1; i < edl.shots.length; i++) {
    const prev = edl.shots[i - 1];
    assert.ok(edl.shots[i].at >= prev.at + prev.dur - 1e-6, `shot ${i} overlaps its predecessor`);
  }
  // 4. Pacing actually varies — a uniform list means the arc never applied.
  const lengths = new Set(edl.shots.map((s) => s.dur.toFixed(2)));
  assert.ok(lengths.size >= 4, `expected varied shot lengths, got ${lengths.size} distinct`);
  // 5. Angles alternate.
  for (let i = 1; i < edl.shots.length; i++) {
    if (edl.shots[i].angle && edl.shots[i - 1].angle) {
      assert.notEqual(edl.shots[i].angle, edl.shots[i - 1].angle, `shots ${i - 1}/${i} share an angle`);
    }
  }
  // 6. Action shots ramp into the impact, and source windows are sane.
  const actions = edl.shots.filter((s) => s.kind === "action");
  // Ramps are an ACCENT, deliberately not applied to every action shot. Ramping
  // all of them made a third of the finished reel duplicate frames, which reads
  // as the picture repeatedly pausing. The hook always gets one; the rest are
  // budgeted to the strongest plays.
  const rampedShots = actions.filter((s) => s.ramp);
  assert.ok(rampedShots.length >= 1, "at least one play is ramped");
  assert.ok(rampedShots.length < actions.length, "ramps are an accent, not applied to every shot");
  assert.ok(edl.shots.find((s) => s.hook)?.ramp, "the hook play is always ramped");
  assert.ok(edl.shots.every((s) => s.srcEnd > s.srcStart), "all source windows are positive");
  ok("planEdit: beat-aligned, hook-on-drop, varied pacing, alternating angles, ramped");

  // The ramp must fit realistic shot lengths. A fixed-size slow window does not,
  // and the feature then silently does nothing.
  assert.ok(solveRamp(3), "ramp fits a 3s shot");
  assert.ok(solveRamp(1.5), "ramp fits a 1.5s shot");
  const r = solveRamp(3);
  const timeline = (r.srcTotal - r.slowSrc) + r.slowSrc / r.speed;
  assert.ok(Math.abs(timeline - 3) < 1e-6, "ramp arithmetic fills the slot exactly");
  ok("solveRamp: scales to the shot and preserves the timeline slot");

  // Pacing must span the MATERIAL, so a short reel still reaches its climax.
  const short = planEdit({
    music,
    plays: plays.slice(0, 4), broll: broll.slice(0, 4),
    outro: [{ src: "g.mp4", start: 200, end: 206, angle: "Z", label: "celeb" }],
    sport: "soccer", opts: { maxDuration: 50 },
  });
  assert.ok(new Set(short.shots.map((s) => s.dur.toFixed(2))).size >= 3, "arc still varies with little material");
  assert.ok(Math.max(...short.shots.map((s) => s.dur)) <= 6, "no shot balloons when material runs out");
  ok("planEdit: arc adapts to available footage; outro stays bounded");
}

// -------------------------------------------- unit: gaps, whips, motion
{
  const bpm = 120;
  const per = 60 / bpm;
  const beats = Array.from({ length: 120 }, (_, i) => +(i * per).toFixed(4));
  const music = { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), drop: beats[9], duration: 60, path: "m.mp3" };
  const mk = (dirs) => dirs.map((d, i) => ({
    src: "g.mp4", start: 5 + i * 12, end: 16 + i * 12, peak: 10 + i * 12,
    score: 0.9 - i * 0.06, angle: ["A", "B"][i % 2], title: `P${i}`, motionDir: d,
  }));

  // No B-roll means the runway before the drop cannot be filled. The timeline
  // must still be gapless — otherwise the renderer concatenates shots and the
  // reel comes out seconds shorter than the plan claims.
  const noBroll = planEdit({ music, plays: mk([0.05, 0.06, 0.05]), broll: [], outro: [], sport: "football", opts: { maxDuration: 20 } });
  assert.ok(Math.abs(noBroll.duration - noBroll.contentDuration) < 0.01, "plan has no gaps");
  assert.equal(noBroll.shots[0].at, 0, "timeline starts at zero");
  assert.ok(noBroll.music.offset > 0, "music is offset so the hook still lands on the drop");
  assert.ok(noBroll.sfx.every((c) => c.at >= 0), "no sfx cue scheduled before the reel starts");
  ok("planEdit: no leading gap when the intro runway can't be filled");

  // The IMPACT must land on a beat, not just the cut. Cutting on the grid while
  // the moment of impact falls mid-shot is what makes an edit feel "a little
  // off" even when every splice is mathematically correct.
  {
    const b128 = Array.from({ length: 100 }, (_, i) => +((i * 60) / 128).toFixed(4));
    const m128 = { bpm: 128, beats: b128, downbeats: b128.filter((_, i) => i % 4 === 0), drop: b128[8], duration: 45, path: "m" };
    const pl = Array.from({ length: 6 }, (_, i) => ({
      src: "g", start: i * 10, end: i * 10 + 8, peak: i * 10 + 4,
      score: 0.9 - i * 0.05, angle: ["A", "B"][i % 2], title: `P${i}`, motionDir: 0.01,
    }));
    const edl = planEdit({
      music: m128, plays: pl,
      broll: [{ src: "g", start: 0, end: 3, angle: "X", label: "b" }],
      outro: [{ src: "g", start: 40, end: 44, label: "c" }],
      sport: "7v7", opts: { maxDuration: 32 },
    });
    const actions = edl.shots.filter((s) => s.kind === "action" && s.ramp);
    assert.ok(actions.length, "action shots were ramped");
    for (const s of actions) {
      // Timeline offset of the peak through the ramp, then absolute reel time.
      const tl = s.ramp.atSrc + s.ramp.slowSrc / (2 * s.ramp.speed);
      const abs = s.at + tl;
      const err = Math.min(...b128.map((b) => Math.abs(b - abs)));
      assert.ok(err <= 0.035, `impact at ${abs.toFixed(3)}s is ${(err * 1000).toFixed(0)}ms off the beat`);
    }
    // Action shots need room to read; B-roll may be shorter.
    const minActionBeats = Math.min(...edl.shots.filter((s) => s.kind === "action").map((s) => s.beats));
    assert.ok(minActionBeats >= 4, `action shots floor at 4 beats (got ${minActionBeats})`);
    ok("planEdit: the impact lands on a beat, action shots stay readable");
  }

  // Whips pair shots that travel the SAME way; anything else cuts hard.
  const same = planEdit({ music, plays: mk([0.05, 0.06, 0.05, 0.07]), broll: [], outro: [], sport: "football", opts: { maxDuration: 30 } });
  assert.ok(same.shots.some((s) => s.transition === "whip"), "matched directions produce a whip");
  const flip = planEdit({ music, plays: mk([0.05, -0.05]), broll: [], outro: [], sport: "football", opts: { maxDuration: 30 } });
  assert.ok(!flip.shots.some((s) => s.transition === "whip"), "no whip across a direction change");
  const still = planEdit({ music, plays: mk([0.003, 0.004]), broll: [], outro: [], sport: "football", opts: { maxDuration: 30 } });
  assert.ok(!still.shots.some((s) => s.transition === "whip"), "no whip when nothing is moving");
  assert.equal(transitionSpec({ transition: "whip", whipDir: 1 }).name, "smoothright");
  assert.equal(transitionSpec({ transition: "whip", whipDir: -1 }).name, "smoothleft");
  assert.ok(transitionSpec({ transition: "hard" }).d < 0.05, "a hard cut is a single frame");
  ok("whip transitions: matched direction only, correct ffmpeg mapping");
}

{
  // The motion detector must follow the busiest BAND, not the average of all
  // movement — on team sports the average is the middle of the field.
  const gw = 64;
  const gh = 36;
  const diff = new Uint8Array(gw * gh);
  // Two clusters: a big one on the right, a small one on the left. The centroid
  // would land between them; the window search must pick the right-hand one.
  for (let y = 10; y < 26; y++) {
    for (let x = 44; x < 56; x++) diff[y * gw + x] = 200;
    for (let x = 4; x < 10; x++) diff[y * gw + x] = 60;
  }
  const m = motionWindow(diff, gw, gh, 16);
  assert.ok(m, "found motion");
  assert.ok(m.cx > gw * 0.6, `window centred on the dominant cluster (got ${m.cx.toFixed(1)} of ${gw})`);
  assert.equal(motionWindow(new Uint8Array(gw * gh), gw, gh, 16), null, "no motion → null");
  ok("motionWindow: tracks the dominant cluster, not the average");
}

// ------------------------------------------------ integration: the reel
{
  console.log("  … rendering a full hype reel (ffmpeg)");
  const game = join(work, "game.mp4");
  await exec(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=s=640x360:d=60:r=30",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=60", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", game], { check: true });

  const music = await analyzeMusic(join(work, "click-120.wav"));
  const plays = Array.from({ length: 5 }, (_, i) => ({
    src: game, start: 5 + i * 10, end: 14 + i * 10, peak: 9 + i * 10,
    score: 0.9 - i * 0.07, angle: ["A", "B", "C"][i % 3], title: `P${i}`,
  }));
  const broll = Array.from({ length: 5 }, (_, i) => ({
    src: game, start: i * 2, end: i * 2 + 3, angle: ["X", "Y"][i % 2], label: `b${i}`,
  }));
  const edl = planEdit({
    music, plays, broll,
    outro: [{ src: game, start: 50, end: 56, angle: "Z", label: "celeb" }],
    sport: "football", opts: { maxDuration: 20 },
  });
  edl.shots.forEach((s) => { s.fit = "cover"; });

  const reel = await renderReel(edl, work, { name: "hype", sfxDir: null });
  assert.ok(existsSync(reel.file), "reel rendered");

  const dims = await exec(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", reel.file], { check: true });
  assert.equal(dims.stdout.trim(), "1080,1920", "reel is 1080x1920 vertical");

  const aud = await exec(FFPROBE, ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_type", "-of", "csv=p=0", reel.file], { check: true });
  assert.equal(aud.stdout.trim(), "audio", "reel carries an audio stream");

  // The whole point of allocating in beats is that the render matches the plan.
  const delta = Math.abs(reel.duration - edl.duration);
  assert.ok(delta <= 0.35, `rendered ${reel.duration.toFixed(2)}s vs planned ${edl.duration.toFixed(2)}s`);

  // Tier-0 sanity: no dead air, no black holes.
  const black = await exec(FFMPEG, ["-hide_banner", "-i", reel.file,
    "-vf", "blackdetect=d=0.5:pic_th=0.98", "-f", "null", "-"], {});
  assert.ok(!/black_start/.test(black.stderr), "no black run longer than 0.5s");

  const cover = await exportCover(reel.file, work, edl.cover, "cover.jpg");
  assert.ok(existsSync(cover), "cover frame exported");
  ok("renderReel: 1080x1920 + audio, duration matches the plan, no black frames");
}

// ============================================================ watching
// The vision pass runs through its `mock` seam here — no tokens, no network.
{
  const frames = Array.from({ length: 25 }, (_, i) => ({ t: i * 0.5, path: `/tmp/f${i}.jpg` }));

  // Labels are matched back by TIMESTAMP, not array position. A model that
  // returns fewer entries than it was given would otherwise shift every later
  // label onto the wrong moment — silently mislabelling the whole video.
  const omitted = new Set();
  const dropped = await labelFrames(frames, {
    mock: (_p, batch) => ({
      frames: batch
        .filter((f, i) => {
          if (i === 3) { omitted.add(f.t); return false; } // model omits one per batch
          return true;
        })
        .map((f) => ({ t: f.t, label: f.t < 5 ? "action" : "broll", description: "x" })),
    }),
  });
  assert.equal(dropped.length, frames.length, "every requested frame comes back");
  assert.ok(omitted.size >= 1, "the mock actually omitted something");
  for (const f of dropped) {
    const expected = omitted.has(f.t) ? "unclear" : f.t < 5 ? "action" : "broll";
    assert.equal(f.label, expected, `frame at ${f.t}s kept its own label`);
  }
  ok("labelFrames: results matched by timestamp, gaps become 'unclear'");

  // Regression: the parent command declares its own `-o, --out` (default
  // "clips"), which silently swallowed the same flag on the `watch`/`inspect`
  // subcommands so they wrote to their defaults instead of the requested
  // directory. `enablePositionalOptions()` is what fixes it, and this asserts
  // the wiring rather than the fix.
  {
    const p = new Command();
    p.enablePositionalOptions();
    p.argument("<input>").option("-o, --out <dir>", "parent", "clips").action(() => {});
    let seen = null;
    p.command("watch <input>").option("-o, --out <dir>", "child", "watch").action((_i, o) => { seen = o.out; });
    p.parse(["node", "x", "watch", "v.mp4", "--out", "/tmp/requested"]);
    assert.equal(seen, "/tmp/requested", "subcommand --out is not shadowed by the parent's");
    ok("CLI: subcommand options are not swallowed by the parent");
  }

  const mix = labelMix([
    { label: "action" }, { label: "action" }, { label: "broll" }, { label: "crowd" },
  ]);
  assert.equal(mix.action, 0.5);
  assert.equal(mix.broll, 0.25);
  assert.ok(Math.abs(Object.values(mix).reduce((a, b) => a + b, 0) - 1) < 1e-9, "mix sums to 1");
  assert.equal(estimateTokens(100), 19700, "token estimate is frames × 197");
  assert.equal(resolveDensity("forensic"), 4);
  assert.equal(resolveDensity(3), 3);
  assert.equal(resolveDensity("nonsense"), 1, "unknown density falls back to 1/s");
  ok("labelMix / estimateTokens / resolveDensity");

  // Not-measured is NOT zero. Summarising a run where the vision pass never
  // executed must not report "0% live action" — that is the same overconfident
  // claim the module exists to prevent.
  const unwatched = summarize({
    duration: 60, frames: 30, density: 0.5, cuts: [], music: null,
    watched: false, mix: { action: 0, broll: 0, celebration: 0, crowd: 0, unclear: 1 },
  });
  assert.ok(/not assessed/i.test(unwatched), "unwatched runs say so");
  assert.ok(!/0% .*live action/i.test(unwatched), "unwatched runs never claim 0% action");

  const watched = summarize({
    duration: 60, frames: 30, density: 0.5, cuts: [], music: null,
    watched: true, mix: { action: 0.5, broll: 0.5, celebration: 0, crowd: 0, unclear: 0 },
  });
  assert.ok(/50% live action/.test(watched), "watched runs report the real figure");
  ok("summarize: never reports a percentage it did not measure");

  // Contiguous runs of action become spans a reel can be cut from.
  const spans = actionSpans({
    density: 1,
    timeline: [
      { t: 0, label: "broll" }, { t: 1, label: "action" }, { t: 2, label: "action" },
      { t: 3, label: "action" }, { t: 4, label: "broll" }, { t: 5, label: "action" },
    ],
  }, { minLen: 1.5 });
  assert.equal(spans.length, 1, "only the run long enough to use is returned");
  assert.equal(spans[0].start, 1);
  ok("actionSpans: contiguous live action becomes usable ranges");
}

// ============================================================ learning
// All pure — measurements in, style out. No ffmpeg, no network, no model.
{
  const beats = Array.from({ length: 64 }, (_, i) => +(i * 0.5).toFixed(3)); // 120 BPM

  // Cuts placed exactly on beats must score far above chance; cuts placed
  // deliberately between them must not. Chance is NOT zero — with a ±60ms
  // window against a beat every 500ms a random cut lands "on beat" ~24% of the
  // time — so the lift over chance is what actually means anything.
  const onBeat = beatAlignment([1.0, 2.0, 3.0, 4.0, 5.0], beats);
  assert.ok(onBeat.onBeatPct > 0.95, "cuts on the grid read as on-beat");
  assert.ok(onBeat.lift > 0.5, "and well above chance");
  const offBeat = beatAlignment([1.25, 2.25, 3.25, 4.25, 5.25], beats);
  assert.equal(offBeat.onBeatPct, 0, "cuts between beats do not count");
  assert.ok(onBeat.chance > 0 && onBeat.chance < 1, "chance is reported, not assumed zero");
  ok("beatAlignment: measures cut-to-beat lift over chance");

  // A clear monotonic acceleration should be recognised confidently.
  const accelerating = [4, 3.6, 3.2, 2.8, 2.4, 2.0, 1.6, 1.2, 0.9, 0.6];
  const acc = fitArc(accelerating);
  assert.equal(acc.arc, "build", "shortening shots read as a build");
  assert.ok(acc.confident, "a clean ramp is a confident fit");

  // Noise must NOT be dressed up as a shape. Asserting an arc that is really
  // just the best of several bad correlations would quietly reshape an edit —
  // measured at 0.185 on a real reel, which is noise wearing a label.
  const noise = [2, 2.1, 1.9, 2.05, 1.95, 2.02, 1.98, 2.01];
  const n = fitArc(noise);
  assert.equal(n.confident, false, "a weak correlation is reported as unconfident");
  assert.equal(n.arc, "steady", "and falls back to the neutral arc");
  ok("fitArc: confident on a real shape, honest about noise");

  const style = deriveStyle({
    shots: [
      { start: 0, end: 2, dur: 2, ramped: true, transition: "hard", label: "action" },
      { start: 2, end: 3, dur: 1, ramped: false, transition: "hard", label: "action" },
      { start: 3, end: 5, dur: 2, ramped: false, transition: "hard", label: "broll" },
      { start: 5, end: 6, dur: 1, ramped: false, transition: "hard", label: "action" },
    ],
    beats, bpm: 120, duration: 6,
  }, "unit");
  assert.equal(style.music.bpm, 120);
  assert.equal(style.effects.rampPct, 0.25, "1 of 4 shots ramped");
  assert.equal(style.composition.actionPct, 0.75, "3 of 4 shots are action");
  assert.equal(style.pacing.shots, 4);
  assert.ok(style.pacing.beats.median >= 1, "shot lengths expressed in beats");

  // Without a tempo there is nothing to express beats against — they must be
  // null rather than seconds smuggled in under a beats-shaped key.
  const noTempo = deriveStyle({ shots: style.shots ?? [], beats: [], bpm: null, duration: 6 }, "x");
  assert.equal(noTempo.pacing.beats.median, null, "no tempo → no beat figures");
  ok("deriveStyle: ramp/action fractions, beats only when a tempo exists");

  // An explicit flag must always beat a learned style, and the run must be able
  // to say where each value came from.
  const s = { pacing: { arc: "build", beats: { min: 5 } }, effects: { rampPct: 0.5 }, grade: { preset: "film" } };
  const fromStyle = styleToPlanOpts(s, {});
  assert.equal(fromStyle.opts.arc, "build");
  assert.equal(fromStyle.provenance.arc, "style");
  const overridden = styleToPlanOpts(s, { arc: "steady" });
  assert.equal(overridden.opts.arc, "steady", "an explicit flag wins");
  assert.equal(overridden.provenance.arc, "flag", "and provenance says so");
  assert.equal(resolveRampCount(s, 10, undefined), 5, "ramp fraction becomes a count");
  assert.equal(resolveRampCount(s, 10, 2), 2, "an explicit ramp count wins");
  ok("styleToPlanOpts: flags beat styles, provenance is recorded");
}

console.log(`\n\x1b[32m\x1b[1m${passed} tests passed\x1b[0m`);
