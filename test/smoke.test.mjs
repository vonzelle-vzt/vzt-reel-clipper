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
import { exec, ffprobeDuration } from "../src/util.js";

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

// ------------------------------------------------------- integration: ffmpeg
const src = join(work, "game.mp4");
console.log("  … generating synthetic fixture (ffmpeg)");
await exec("ffmpeg", [
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
  const w = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0",
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

console.log(`\n\x1b[32m\x1b[1m${passed} tests passed\x1b[0m`);
