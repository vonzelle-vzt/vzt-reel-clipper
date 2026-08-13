import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, log } from "./util.js";
import { analyzeMusic } from "./music.js";

/**
 * Apple Music integration — tempo and drop for tracks the editor cannot
 * touch as a file.
 *
 * Apple Music subscription files are DRM-protected; ffmpeg cannot decode
 * them and this module makes no attempt to circumvent that. Instead it
 * pulls the two numbers the hype edit actually needs from sources that are
 * legitimately reachable:
 *
 *   TEMPO — the public iTunes Search API returns a DRM-free 30-second AAC
 *           preview for almost every catalog track. That's plenty of audio
 *           for music.js's onset/tempo estimator to lock onto a BPM.
 *   DROP  — the preview is a ~30s excerpt from the MIDDLE of the song, so
 *           its internal timeline has nothing to do with the full track's
 *           structure. Any "drop" music.js finds inside the preview is
 *           meaningless here and must be discarded. The real drop can only
 *           come from a human: either `--drop <sec>` (a known timestamp) or
 *           `nowPlaying()`, which reads the Music app's own playhead while
 *           you scrub the actual track to the drop.
 *
 * Same division of labour as the rest of the repo: fetch/osascript hand
 * over data, music.js does the maths, this module wires them together.
 */

const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";

/**
 * Search the iTunes Search API for candidate tracks.
 *
 * @param {string} query free-text search, e.g. "dreams and nightmares meek mill"
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array<{trackName:string, artistName:string, collectionName:string, durationSec:number, previewUrl:string|null, trackId:number}>>}
 */
export async function searchTracks(query, { limit = 5 } = {}) {
  if (!query || !query.trim()) throw new Error("searchTracks: query is required");
  const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(query)}&entity=song&limit=${encodeURIComponent(limit)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`iTunes Search API request failed: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`iTunes Search API returned ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  const results = body.results || [];
  if (!results.length) {
    throw new Error(`iTunes Search API found no results for "${query}"`);
  }
  return results.map((r) => ({
    trackName: r.trackName,
    artistName: r.artistName,
    collectionName: r.collectionName,
    durationSec: r.trackTimeMillis ? r.trackTimeMillis / 1000 : null,
    previewUrl: r.previewUrl || null,
    trackId: r.trackId,
  }));
}

/**
 * Download a preview (or any URL) to disk.
 *
 * @param {string} previewUrl
 * @param {string} outPath
 * @returns {Promise<string>} outPath
 */
export async function fetchPreview(previewUrl, outPath) {
  let res;
  try {
    res = await fetch(previewUrl);
  } catch (err) {
    throw new Error(`failed to download preview: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`preview download returned ${res.status} ${res.statusText}`);
  }
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

/**
 * Resolve a BPM (and beat grid) for a search query via its 30s preview.
 *
 * @param {string} query
 * @param {string} workDir directory to download the preview into
 * @param {{index?: number}} [opts] `index` picks a result other than the first
 * @returns {Promise<{track: object, bpm: number, beats: number[], downbeats: number[], duration: number, previewPath: string}>}
 */
export async function tempoFromPreview(query, workDir, opts = {}) {
  const results = await searchTracks(query, { limit: (opts.index ?? 0) + 1 });
  const track = results[opts.index ?? 0];
  if (!track) throw new Error(`no result at index ${opts.index ?? 0} for "${query}"`);
  if (!track.previewUrl) throw new Error(`"${track.trackName}" by ${track.artistName} has no preview available`);

  const previewPath = join(workDir, `preview-${track.trackId}.m4a`);
  await fetchPreview(track.previewUrl, previewPath);

  const analysis = await analyzeMusic(previewPath);

  // Octave sanity. A 30-second excerpt with a busy hi-hat pattern very commonly
  // reads at double the musical tempo — measured 198.8 BPM on a track that is
  // really about half that. Anything above ~175 is flagged with its halved
  // value so the number is questioned rather than trusted, because a doubled
  // tempo halves every shot in the edit and looks like a pacing bug later.
  const suspectDouble = analysis.bpm > 175;
  const suspectHalf = analysis.bpm < 70;
  if (suspectDouble || suspectHalf) {
    const alt = suspectDouble ? analysis.bpm / 2 : analysis.bpm * 2;
    log.warn(
      `${analysis.bpm.toFixed(1)} BPM from a 30s preview may be ${suspectDouble ? "double" : "half"} the real tempo ` +
      `(${alt.toFixed(1)} BPM). Check it, and override with --bpm if wrong.`,
    );
  }
  // The preview is a 30s excerpt from the middle of the track, not the full
  // song — its `drop` timestamp is relative to that excerpt and does not
  // correspond to anything in the real track. BPM is stable across the
  // whole track (produced music is on a fixed grid), so it's fine to keep.
  // The drop must come from --drop or nowPlaying() instead.
  return {
    suspectOctave: suspectDouble || suspectHalf,
    track,
    bpm: analysis.bpm,
    beats: analysis.beats,
    downbeats: analysis.downbeats,
    duration: analysis.duration,
    previewPath,
  };
}

/**
 * Read the currently playing track and playhead position from the Music
 * app, via AppleScript. Used to capture the drop timestamp of a real
 * (DRM-protected) track by scrubbing to it and reading the position.
 *
 * @returns {Promise<{name: string, artist: string, position: number}|null>}
 *   null when nothing is playing or this isn't macOS.
 */
export async function nowPlaying() {
  if (process.platform !== "darwin") return null;
  const script = 'tell application "Music" to return (get name of current track) & "|" & (get artist of current track) & "|" & (player position)';
  const { code, stdout, stderr } = await exec("osascript", ["-e", script]);
  if (code !== 0) {
    // Music.app raises error -1728 ("can't get current track") when nothing
    // is playing — that's an expected, common state, not a failure.
    if (/-1728/.test(stderr)) {
      log.info("nothing is playing in Music — press play and scrub to the drop, then try again");
      return null;
    }
    throw new Error(`osascript failed: ${stderr.trim() || `exit ${code}`}`);
  }
  const [name, artist, position] = stdout.trim().split("|");
  if (!name || position === undefined) return null;
  return { name, artist, position: Number(position) };
}
