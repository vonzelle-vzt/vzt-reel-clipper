import { readFileSync } from "node:fs";
import { exec, log } from "./util.js";

/**
 * Unified transcript shape used by the rest of the pipeline:
 *   { segments: [{start, end, text}], words: [{text, start, end}] }   (seconds)
 */

// Spread a segment's words evenly across its [start,end] when only
// segment-level timing is available (the local WASM path).
function wordsFromSegments(segments) {
  const words = [];
  for (const seg of segments) {
    const toks = seg.text.split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const span = Math.max(0.001, seg.end - seg.start);
    const per = span / toks.length;
    toks.forEach((text, i) => {
      words.push({
        text,
        start: +(seg.start + i * per).toFixed(3),
        end: +(seg.start + (i + 1) * per).toFixed(3),
      });
    });
  }
  return words;
}

/**
 * Local transcription via the already-installed `vintel` CLI (pure-WASM whisper,
 * no API key). Returns segment timing; words are approximated.
 */
export async function transcribeLocal(source, { language } = {}) {
  log.info("transcribing locally via vintel (WASM whisper)…");
  const args = ["transcribe", source];
  if (language) args.push("-l", language);
  // `vintel` resolves from PATH (installed bins). Use shell on Windows for .cmd.
  const { stdout, code, stderr } = await exec("vintel", args, {
    shell: process.platform === "win32",
  });
  if (code !== 0) {
    throw new Error(`vintel transcribe failed (exit ${code}).\n${stderr.slice(-1500)}`);
  }
  // vintel prints a JSON array of TranscriptSegment.
  const jsonStart = stdout.indexOf("[");
  const jsonEnd = stdout.lastIndexOf("]");
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error("could not find JSON transcript in vintel output");
  }
  const raw = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
  const segments = raw
    .map((s) => ({
      start: (s.start_ms ?? 0) / 1000,
      end: (s.end_ms ?? 0) / 1000,
      text: (s.text || "").trim(),
    }))
    .filter((s) => s.text && s.end > s.start);
  return { segments, words: wordsFromSegments(segments) };
}

// --- WebVTT (YouTube auto-subs) parsing, with inline <hh:mm:ss.mmm> word tags ---

function vttTimeToSec(t) {
  // formats: HH:MM:SS.mmm or MM:SS.mmm
  const parts = t.trim().split(":");
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else s = parts[0];
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

/**
 * Parse YouTube-style auto-sub VTT into real word-level timing.
 * Auto-subs embed per-word tags like:  word<00:00:01.234><c> next</c> word2 …
 */
export function parseVtt(vttText) {
  const lines = vttText.split(/\r?\n/);
  const words = [];
  const segments = [];
  let cueStart = null, cueEnd = null;

  const cueRe = /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})\s+-->\s+(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})/;

  const flushWord = (text, start, end) => {
    const clean = text.replace(/<[^>]*>/g, "").trim();
    if (clean) words.push({ text: clean, start, end });
  };

  for (const lineRaw of lines) {
    const line = lineRaw;
    const m = line.match(cueRe);
    if (m) {
      cueStart = vttTimeToSec(m[1]);
      cueEnd = vttTimeToSec(m[2]);
      continue;
    }
    if (cueStart == null) continue;
    if (!line.trim() || line.trim() === "&nbsp;") continue;

    // Strip YouTube cue tags (<c>, </c>, <c.colorXXXXXX>) but KEEP the inline
    // <hh:mm:ss.mmm> timestamp tags that carry word timing.
    const clean = line
      .replace(/<\/?c[^>]*>/gi, "")
      .replace(/&nbsp;/gi, " ");

    const segText = clean.replace(/<[^>]*>/g, "").trim();
    if (segText) segments.push({ start: cueStart, end: cueEnd, text: segText });

    // Split into [text, time, text, time, …]; text chunks are the words spoken
    // starting at the preceding timestamp (or the cue start for the first one).
    const parts = clean.split(/<(\d{1,2}:\d{2}:\d{2}\.\d{3})>/);
    let curStart = cueStart;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        curStart = vttTimeToSec(parts[i]); // a timestamp boundary
        continue;
      }
      const chunk = parts[i].replace(/<[^>]*>/g, "").trim();
      if (!chunk) continue;
      const end = parts[i + 1] ? vttTimeToSec(parts[i + 1]) : cueEnd;
      const toks = chunk.split(/\s+/).filter(Boolean);
      const per = (end - curStart) / toks.length;
      toks.forEach((tk, k) => flushWord(tk, curStart + k * per, curStart + (k + 1) * per));
    }
  }

  // De-dup: YouTube auto-subs repeat lines as they "roll up".
  const seen = new Set();
  const dedupWords = words.filter((w) => {
    const k = `${w.text}@${w.start.toFixed(2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const segSeen = new Set();
  const dedupSegs = segments.filter((s) => {
    const k = `${s.text}@${s.start.toFixed(2)}`;
    if (segSeen.has(k)) return false;
    segSeen.add(k);
    return true;
  });

  return { segments: dedupSegs, words: dedupWords };
}

export function transcriptFromVttFile(path) {
  return parseVtt(readFileSync(path, "utf8"));
}
