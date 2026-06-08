import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, log } from "./util.js";
import { ffprobeDuration } from "./util.js";

/**
 * Sports / no-speech selection.
 *
 * Game film (raw sideline or phone-from-stands) has no usable transcript, so we
 * find the action by AUDIO ENERGY: crowd roar, contact, whistles and sideline
 * reactions all produce loudness spikes. We read ffmpeg's ebur128 momentary
 * loudness (LUFS, 400ms window) over the whole video, then pick the peaks.
 */

// Parse ametadata `print` output: alternating `pts_time:` and `lavfi.r128.M=` lines.
function parseR128(text) {
  const series = [];
  let t = null;
  for (const line of text.split(/\r?\n/)) {
    const pt = line.match(/pts_time:([-\d.]+)/);
    if (pt) { t = parseFloat(pt[1]); continue; }
    const mm = line.match(/lavfi\.r128\.M=(-?[\d.]+|-?inf|nan)/i);
    if (mm && t != null) {
      let M = parseFloat(mm[1]);
      if (!Number.isFinite(M)) M = -120; // silence floor
      series.push({ t, M });
    }
  }
  return series;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Read the loudness curve and return scored peak timestamps (loudest first).
 * @returns {Promise<Array<{t:number, score:number, M:number}>>}
 */
export async function detectAudioPeaks(source, { minGap = 18, sensitivity = 1.0 } = {}) {
  log.info("scanning audio energy (ebur128 loudness)…");
  // Write momentary-loudness metadata to a bare filename inside a temp cwd to
  // dodge Windows drive-letter escaping in the ffmpeg filtergraph.
  const dir = mkdtempSync(join(tmpdir(), "clipit-r128-"));
  const fname = "r128.txt";
  await exec(
    "ffmpeg",
    ["-i", source, "-af", `ebur128=metadata=1,ametadata=mode=print:file=${fname}`, "-f", "null", "-"],
    { cwd: dir, check: true },
  );
  let series;
  try {
    series = parseR128(readFileSync(join(dir, fname), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (series.length < 5) {
    throw new Error("could not read an audio loudness curve — does the video have an audio track?");
  }

  const Ms = series.map((p) => p.M);
  const med = median(Ms);
  const mad = median(Ms.map((x) => Math.abs(x - med))) || 1;
  // Robust threshold: louder than typical by a sensitivity-scaled margin.
  const thresh = med + sensitivity * 1.4826 * mad;

  // Local maxima above threshold (window of ~1.2s on each side).
  const win = Math.max(3, Math.round(1.2 / Math.max(0.05, series[1].t - series[0].t)));
  const candidates = [];
  for (let i = 0; i < series.length; i++) {
    const { t, M } = series[i];
    if (M < thresh) continue;
    let isMax = true;
    for (let j = Math.max(0, i - win); j <= Math.min(series.length - 1, i + win); j++) {
      if (series[j].M > M) { isMax = false; break; }
    }
    if (isMax) candidates.push({ t, M, score: M - med });
  }

  // Greedy non-maximum suppression by time gap (keep loudest, drop neighbors).
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of candidates) {
    if (kept.every((p) => Math.abs(p.t - c.t) >= minGap)) kept.push(c);
  }

  // Drop weak peaks: a real play should stand clearly above the baseline. This
  // prevents padding a reel with non-events when fewer plays exist than asked.
  if (!kept.length) return kept;
  const topScore = kept[0].score;
  const floor = Math.max(3, topScore * 0.25);
  return kept.filter((p) => p.score >= floor);
}

/**
 * Turn peaks into ordered clip windows. The reaction spike lags the play, so we
 * start the clip BEFORE the peak (capture the snap/buildup) and end after it.
 */
export async function selectSportsClips(source, {
  count = 8,
  preroll = 7,
  postroll = 4,
  minGap = 18,
  sensitivity = 1.0,
} = {}) {
  const dur = await ffprobeDuration(source);
  const peaks = await detectAudioPeaks(source, { minGap, sensitivity });
  if (!peaks.length) throw new Error("no audio-energy peaks found — try lowering --sensitivity");

  const top = peaks.slice(0, count);
  const clips = top
    .map((p, i) => ({
      start: Math.max(0, p.t - preroll),
      end: Math.min(dur, p.t + postroll),
      peak: p.t,
      score: +p.score.toFixed(1),
      title: `Big Play ${i + 1}`,
      reason: `audio-energy peak at ${p.t.toFixed(1)}s (+${p.score.toFixed(1)} LU over baseline)`,
    }))
    .filter((c) => c.end - c.start >= 4)
    .sort((a, b) => a.start - b.start); // chronological for output

  // Renumber chronologically.
  clips.forEach((c, i) => (c.title = `Big Play ${i + 1}`));
  return clips;
}
