import { exec, log } from "./util.js";

/**
 * Ask the local `claude` CLI (subscription, no API cost) to pick the N most
 * clip-worthy moments from a timestamped transcript.
 * Returns [{ start, end, title, reason }] in seconds.
 */
export async function selectClips(segments, { count = 5, minLen = 18, maxLen = 60, model = "sonnet" } = {}) {
  if (!segments.length) throw new Error("transcript is empty — nothing to select");

  // Compact timestamped transcript for the prompt.
  const tx = segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");

  const total = segments[segments.length - 1].end;
  const prompt = `You are a viral short-form video editor. Below is a timestamped transcript of a ${Math.round(total)}s video. Each line is [start-end] text (seconds).

Pick the ${count} BEST standalone moments to cut into vertical shorts (TikTok/Reels/Shorts). Each clip must:
- be a self-contained idea with a strong hook in its first seconds
- be between ${minLen} and ${maxLen} seconds long
- snap start/end to transcript boundaries (don't cut mid-sentence)
- not overlap other chosen clips

Return ONLY a JSON array, no prose, no markdown fences. Each item:
{"start": <seconds>, "end": <seconds>, "title": "<punchy <=8 word hook for caption/filename>", "reason": "<why it'll perform, 1 sentence>"}

TRANSCRIPT:
${tx}`;

  log.info(`asking claude (${model}) to pick ${count} clips…`);
  const { stdout, code, stderr } = await exec("claude", ["-p", "--model", model], {
    stdin: prompt,
    shell: process.platform === "win32",
  });
  if (code !== 0) throw new Error(`claude CLI failed (exit ${code}).\n${stderr.slice(-1000)}`);

  const a = stdout.indexOf("[");
  const b = stdout.lastIndexOf("]");
  if (a < 0 || b < 0) throw new Error(`no JSON array in claude output:\n${stdout.slice(0, 500)}`);
  let clips;
  try {
    clips = JSON.parse(stdout.slice(a, b + 1));
  } catch (e) {
    throw new Error(`could not parse claude JSON: ${e.message}\n${stdout.slice(a, b + 1).slice(0, 500)}`);
  }

  // Sanitize: clamp to bounds, enforce length, drop overlaps.
  const cleaned = [];
  for (const c of clips) {
    let start = Math.max(0, Number(c.start));
    let end = Math.min(total, Number(c.end));
    if (!(end > start)) continue;
    if (end - start < minLen) end = Math.min(total, start + minLen);
    if (end - start > maxLen) end = start + maxLen;
    const overlaps = cleaned.some((p) => start < p.end && end > p.start);
    if (overlaps) continue;
    cleaned.push({ start, end, title: String(c.title || "clip").trim(), reason: String(c.reason || "").trim() });
    if (cleaned.length >= count) break;
  }
  if (!cleaned.length) throw new Error("claude returned no usable clips");
  return cleaned;
}
