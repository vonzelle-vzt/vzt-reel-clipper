import { fmtClock } from "./util.js";

// ASS colors are &HBBGGRR&.
const COL_BASE = "&H00FFFFFF"; // white text
const COL_ACTIVE = "&H0000F0FF"; // bright yellow/gold highlight (BBGGRR = FF F0 00)
const COL_OUTLINE = "&H00000000"; // black outline

const W = 1080;
const H = 1920;

function escapeText(t) {
  // Strip ASS-special characters so they can't break the override syntax.
  return String(t).replace(/[\\{}]/g, "").replace(/\r?\n/g, " ").trim();
}

/**
 * Group a flat word list into short on-screen phrases.
 * Breaks on long pauses, max word count, or max character length.
 */
function chunkPhrases(words, { maxWords = 4, maxChars = 22, pauseGap = 0.6 } = {}) {
  const phrases = [];
  let cur = [];
  let curChars = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = escapeText(w.text);
    if (!text) continue;
    const wordObj = { ...w, text };
    const wouldChars = curChars + text.length + 1;
    const prev = cur[cur.length - 1];
    const gap = prev ? w.start - prev.end : 0;
    if (cur.length && (cur.length >= maxWords || wouldChars > maxChars || gap > pauseGap)) {
      phrases.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(wordObj);
    curChars += text.length + 1;
  }
  if (cur.length) phrases.push(cur);
  return phrases;
}

/**
 * Build a full .ass file (string) for one clip.
 * `words` carry start/end in SECONDS relative to the clip start (clip begins at 0).
 * Produces one Dialogue per word so the active word is highlighted karaoke-style.
 */
export function buildAss(words, opts = {}) {
  const fontName = opts.font || "Arial";
  const fontSize = opts.fontSize || 96;
  const marginV = opts.marginV || 320; // distance from bottom — sits in lower third
  const phrases = chunkPhrases(words, opts);

  // Flatten to a global word list, each word remembering its phrase + index,
  // so every instant maps to exactly one word (no overlapping Dialogue events).
  const flat = [];
  for (const phrase of phrases) {
    phrase.forEach((w, idx) => flat.push({ w, phrase, idx }));
  }

  const events = [];
  for (let g = 0; g < flat.length; g++) {
    const { w, phrase, idx } = flat[g];
    const start = w.start;
    // Hold each word until the next word begins anywhere in the clip; the last
    // word lingers briefly. This guarantees windows never overlap.
    const end = g + 1 < flat.length ? flat[g + 1].w.start : w.end + 0.3;
    if (end <= start) continue;

    // Render the whole phrase; wrap the active word in an override block that
    // recolors it and pops its scale up slightly.
    const line = phrase
      .map((pw, j) =>
        j === idx
          ? `{\\c${COL_ACTIVE}\\fscx118\\fscy118}${pw.text}{\\c${COL_BASE}\\fscx100\\fscy100}`
          : pw.text,
      )
      .join(" ");

    // Fields: Layer,Start,End,Style,Name,MarginL,MarginR,Effect,Text (Effect empty).
    events.push(`Dialogue: 0,${fmtClock(start)},${fmtClock(end)},Main,,0,0,,${line}`);
  }

  return wrapAss({ fontName, fontSize, marginV, alignment: 2, events });
}

/**
 * A single static title banner (top-centered) for the whole clip — used by
 * sports/no-speech mode where there's no transcript to animate.
 */
export function buildTitleAss(title, durationSec, opts = {}) {
  const fontName = opts.font || "Arial";
  const fontSize = opts.fontSize || 84;
  const text = escapeText(title).toUpperCase();
  const events = [
    `Dialogue: 0,${fmtClock(0)},${fmtClock(durationSec)},Main,,0,0,,${text}`,
  ];
  // Alignment 8 = top-center; MarginV here is distance from the TOP.
  return wrapAss({ fontName, fontSize, marginV: opts.marginV || 140, alignment: 8, events });
}

function wrapAss({ fontName, fontSize, marginV, alignment, events }) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${fontName},${fontSize},${COL_BASE},${COL_BASE},${COL_OUTLINE},&H64000000,-1,0,0,0,100,100,0,0,1,6,3,${alignment},80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text
${events.join("\n")}
`;
}
