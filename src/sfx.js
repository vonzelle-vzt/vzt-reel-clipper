import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * SFX mixing, ported from vzt-reel-studio/src/sfx.js. That version resolved
 * sample names against a bundled assets/sfx directory shipped in the repo;
 * this one resolves against a USER-OWNED library directory instead, laid
 * out by category (<sfxDir>/whoosh/*.wav, <sfxDir>/impact/*.wav, …), so we
 * never commit copyrighted audio assets alongside the tool. `buildSfxMix`
 * itself is unchanged in behaviour — only how a cue's sfx name becomes a
 * file path is different, and that resolution is now injected as a
 * parameter so this module stays pure and testable.
 */

const SFX_EXTS = new Set([".wav", ".mp3"]);

/**
 * Scan a user's sfx library once per category and return a resolver that
 * picks a deterministic variant per cue, so repeated cues (e.g. three
 * "whoosh" transitions in one reel) rotate through samples instead of
 * always firing the same file.
 *
 * Fail-soft throughout: a missing library directory, a missing/empty
 * category subdirectory, or an unreadable category all resolve to
 * `resolve()` returning null (never throw) so a cue with no usable sample
 * is simply skipped by the caller.
 *
 * @param {string} sfxDir  root of the user's sfx library
 * @returns {{resolve: (category: string, variantIndex?: number) => string|null}}
 */
export function createSfxLibrary(sfxDir) {
  const cache = new Map(); // category -> string[] (sorted absolute paths)

  function filesFor(category) {
    if (cache.has(category)) return cache.get(category);
    let files = [];
    const dir = join(sfxDir, category);
    try {
      files = readdirSync(dir)
        .filter((f) => SFX_EXTS.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => join(dir, f));
    } catch {
      files = []; // missing dir, permission error, etc — fail soft
    }
    cache.set(category, files);
    return files;
  }

  return {
    /**
     * `fallbacks` lets a cue ask for a more specific sample and degrade to a
     * general one: a hit-to-slow wants an impact with a long TAIL that lingers
     * through the slow section, but a library with only `impact/` should still
     * produce a hit rather than silence.
     */
    resolve(category, variantIndex = 0, fallbacks = []) {
      if (!category || !existsSync(sfxDir)) return null;
      let files = filesFor(category);
      for (const alt of fallbacks) {
        if (files.length) break;
        files = filesFor(alt);
      }
      if (!files.length) return null;
      const idx = ((variantIndex % files.length) + files.length) % files.length;
      return files[idx];
    },
  };
}

/**
 * Build the ffmpeg input args + audio filtergraph for mixing SFX hits over
 * the base audio. Each hit is delayed to its cue start with adelay, then all
 * are mixed with the base track without renormalizing the narration.
 *
 * @param {Array<{sfx?: string, start: number, variant?: number}>} cues
 * @param {number} firstSfxInputIndex  ffmpeg input index of the first sfx file
 * @param {{resolve: (category: string, variantIndex?: number) => string|null}} library
 * @returns {{inputs: string[], filter: string, outLabel: string}|null}
 */
export function buildSfxMix(cues, firstSfxInputIndex, library) {
  const hits = cues
    .map((c) => ({ path: c.sfx ? library.resolve(c.sfx, c.variant ?? 0) : null, start: c.start }))
    .filter((h) => h.path);
  if (!hits.length) return null;

  const inputs = hits.flatMap((h) => ["-i", h.path]);
  const parts = [];
  const labels = [];
  hits.forEach((h, i) => {
    const idx = firstSfxInputIndex + i;
    const ms = Math.max(0, Math.round(h.start * 1000));
    parts.push(`[${idx}:a]adelay=${ms}|${ms},volume=0.55[sfx${i}]`);
    labels.push(`[sfx${i}]`);
  });
  parts.push(`[0:a]${labels.join("")}amix=inputs=${hits.length + 1}:duration=first:normalize=0[aout]`);
  return { inputs, filter: parts.join(";"), outLabel: "[aout]" };
}
