import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exec, log, FFMPEG, ffprobeDuration } from "./util.js";

/**
 * Frame extraction and contact sheets — the cheap half of watching.
 *
 * Zero tokens, zero model calls. A contact sheet is what actually exposed
 * every selection bug found on real footage: that a "recruiting highlight" was
 * a warm-up session, and that the moments the scorer ranked highest were
 * players standing with their hands on their hips. Statistics hid all of it;
 * one image showed it immediately.
 *
 * This stays a first-class command so the fast look is always one step away,
 * and so `watch` has frames to hand to the model.
 */

/** Frames handed to a model. 512px matches ~197 vision tokens per frame. */
const FRAME_W = 512;

/** Tiles in a contact sheet, and the width of each tile. */
const SHEET_COLS = 6;
const SHEET_TILE_W = 220;

/**
 * Sample frames at a fixed rate and write them as numbered JPEGs.
 *
 * ffmpeg names outputs sequentially, so timestamps are reconstructed from the
 * index rather than parsed back out of filenames — `fps=N` emits frames at
 * exact 1/N intervals starting at the first frame.
 *
 * @returns {Promise<Array<{t:number, path:string}>>}
 */
export async function extractFrames(source, outDir, { density = 1, width = FRAME_W, start = 0, end } = {}) {
  mkdirSync(outDir, { recursive: true });
  const args = ["-y"];
  if (start) args.push("-ss", String(start));
  if (end != null && end > start) args.push("-t", String(end - start));
  args.push(
    "-i", source,
    "-vf", `fps=${density},scale=${width}:-2`,
    "-q:v", "5",
    "frame-%05d.jpg",
  );
  await exec(FFMPEG, args, { cwd: outDir, check: true });

  return readdirSync(outDir)
    .filter((f) => /^frame-\d+\.jpg$/.test(f))
    .sort()
    .map((f, i) => ({
      t: +(start + i / density).toFixed(3),
      path: join(outDir, f),
    }));
}

/**
 * One tiled contact sheet covering the whole video.
 *
 * Rows are capped so a long source produces a readable sheet rather than a
 * postage-stamp mosaic; the sample rate is derived from the duration.
 */
export async function contactSheet(source, outPath, { tiles = 30, width = SHEET_TILE_W } = {}) {
  const dur = await ffprobeDuration(source);
  const every = Math.max(0.5, dur / tiles);
  const rows = Math.ceil(tiles / SHEET_COLS);
  await exec(
    FFMPEG,
    ["-y", "-i", source,
      "-vf", `fps=1/${every.toFixed(3)},scale=${width}:-2,tile=${SHEET_COLS}x${rows}`,
      "-frames:v", "1", outPath],
    { check: true },
  );
  log.ok(`contact sheet → ${outPath}  (${tiles} tiles, one per ${every.toFixed(1)}s)`);
  return outPath;
}

/**
 * Grab one frame. Used for covers and for spot-checking a single moment.
 */
export async function frameAt(source, t, outPath, { width = FRAME_W } = {}) {
  await exec(
    FFMPEG,
    ["-y", "-ss", Math.max(0, t).toFixed(3), "-i", source, "-frames:v", "1",
      "-vf", `scale=${width}:-2`, "-q:v", "4", outPath],
    { check: true },
  );
  return outPath;
}
