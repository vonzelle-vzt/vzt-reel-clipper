/**
 * Color grading presets — named ffmpeg filter strings built only from
 * `curves`, `eq`, and `colorbalance` (all confirmed present in the bundled
 * ffmpeg-static build; no lut3d dependency for the presets themselves).
 * Kept deliberately subtle: these are meant to read as a competent color
 * pass, not an Instagram filter. If a preset needs squinting to notice at
 * normal viewing distance, that's the point — push harder and it starts
 * fighting the footage instead of supporting it.
 *
 * LUT support is separate: `gradeFilter(name, {lut})` hands back a bare
 * `lut3d=<file>` filter when a `.cube` path is given. Per docs/ARCHITECTURE.md
 * ("ffmpeg filtergraph paths"), filtergraph option values choke on Windows
 * drive-letter colons and backslashes, so this module does NOT accept or
 * emit an absolute path — the caller is responsible for running ffmpeg with
 * `cwd` set to the LUT's directory (see util.js `exec`'s `cwd` option) and
 * passing only the bare filename in `lut`. This function trusts the name
 * it's given as-is; it does not resolve or validate the path.
 */

export const GRADES = {
  // Mild contrast + saturation lift — makes footage look intentional
  // without crushing shadows or blowing out skin tones.
  punch: "eq=contrast=1.06:saturation=1.12,curves=preset=increase_contrast",

  // Subtle split tone: cool shadows, warm highlights. The classic
  // "cinematic" look, dialed down to a whisper so it survives re-encoding
  // and small preview thumbnails without banding.
  "teal-orange": "colorbalance=rs=-0.04:gs=0.0:bs=0.05:rh=0.06:gh=0.02:bh=-0.05",

  // Lifted blacks + slight desaturation — a soft, filmic low-contrast look
  // for talking-head or vlog-style footage that shouldn't feel punchy.
  film: "curves=master='0/0.04 0.5/0.5 1/0.96',eq=saturation=0.9",
};

/**
 * Resolve a grade name to an ffmpeg video filter string.
 * @param {string} name  one of GRADES' keys, or "none"
 * @param {{lut?: string}} [opts]  bare LUT filename (see module header for
 *   the cwd contract — never pass an absolute/relative path with separators)
 * @returns {string|null}  filter string, or null for "none"/unknown names
 */
export function gradeFilter(name, { lut } = {}) {
  if (lut) return `lut3d=${lut}`;
  if (!name || name === "none") return null;
  return GRADES[name] || null;
}
