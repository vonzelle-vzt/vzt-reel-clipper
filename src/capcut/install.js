import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { exec, log, FFPROBE } from "../util.js";
import { edlToDraft, validateDraft, us } from "./draft.js";

/**
 * Writing a generated draft into CapCut's own project store.
 *
 * CapCut discovers projects by scanning its drafts directory and reading
 * `root_meta_info.json`, so installing a project means writing the folder AND
 * registering it. Skipping the registration produces a draft that exists on
 * disk and never appears in the app — a silent failure that looks like the
 * writer is broken.
 *
 * Everything here is deliberately conservative: an existing project is never
 * overwritten without `force`, and the draft is validated before a byte is
 * written, because a malformed draft does not error — CapCut opens it and shows
 * an empty timeline.
 */

/** CapCut International's macOS drafts directory. */
export function draftsDir() {
  return join(homedir(), "Movies", "CapCut", "User Data", "Projects", "com.lveditor.draft");
}

/** Is CapCut installed with a drafts directory we can write to? */
export function capcutAvailable() {
  return existsSync(draftsDir());
}

/** Probe a media file for the fields the draft needs. */
export async function probeMedia(path) {
  const { stdout } = await exec(
    FFPROBE,
    ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-show_entries", "format=duration",
      "-of", "default=nw=1", path],
    { check: true },
  );
  const get = (k) => {
    const m = stdout.match(new RegExp(`${k}=([\\d.]+)`));
    return m ? +m[1] : null;
  };
  const { stdout: a } = await exec(
    FFPROBE,
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
    {},
  );
  return {
    path: resolve(path),
    width: get("width") ?? 1920,
    height: get("height") ?? 1080,
    durationSec: get("duration") ?? 0,
    hasAudio: a.trim().length > 0,
  };
}

/**
 * Register the project so CapCut's library lists it.
 *
 * `root_meta_info.json` is the index the app reads on launch. It is merged
 * rather than replaced — clobbering it would delete the user's other projects
 * from the library even though their folders survive on disk.
 */
function registerDraft(dir, draftDir, name, durationUs, draftId) {
  const rootPath = join(dir, "root_meta_info.json");
  let root = { all_draft_store: [] };
  if (existsSync(rootPath)) {
    try {
      root = JSON.parse(readFileSync(rootPath, "utf8"));
      if (!Array.isArray(root.all_draft_store)) root.all_draft_store = [];
    } catch {
      log.warn("root_meta_info.json unreadable — starting a fresh index (existing project folders are untouched)");
      root = { all_draft_store: [] };
    }
  }
  const now = Date.now();
  // Preserve whatever CapCut already recorded for this project — it adds a large
  // set of cloud/sync fields on first scan, and dropping them makes the entry
  // look malformed to the app.
  const prior = root.all_draft_store.find((d) => d?.draft_name === name) || {};
  root.all_draft_store = root.all_draft_store.filter((d) => d?.draft_name !== name);
  root.all_draft_store.unshift({
    ...prior,
    draft_fold_path: draftDir,
    // The index keys on the draft's own UUID, not the folder name. Writing the
    // folder name here produces a project that exists on disk, passes every
    // validation, and never appears in CapCut's library — the exact silent
    // failure this module was written to prevent.
    draft_id: draftId,
    draft_name: name,
    draft_timeline_materials_size: 0,
    tm_draft_create: now * 1000,
    tm_draft_modified: now * 1000,
    draft_removable: true,
    draft_json_file: join(draftDir, "draft_content.json"),
    draft_cover: join(draftDir, "draft_cover.jpg"),
    // CapCut reads `tm_duration`. `draft_duration` is ignored, so a project
    // registered with it shows a 00:00 runtime in the library.
    tm_duration: durationUs,
  });
  writeFileSync(rootPath, JSON.stringify(root));
  return rootPath;
}

/**
 * Generate and install a CapCut project from an EDL.
 *
 * @param {object} edl
 * @param {object} opts { name, music, cover, force, copyMedia }
 * @returns {Promise<{dir:string, name:string, segments:number}>}
 */
export async function installDraft(edl, opts = {}) {
  const dir = draftsDir();
  if (!existsSync(dir)) {
    throw new Error(
      `CapCut drafts folder not found at ${dir}\n` +
        "  Open CapCut once so it creates its project store, then try again.",
    );
  }

  const name = opts.name || "VZT Hype Reel";
  const draftDir = join(dir, name.replace(/[^\w -]/g, "").trim() || "VZT Hype Reel");
  if (existsSync(draftDir) && !opts.force) {
    throw new Error(`a CapCut project named "${name}" already exists — pass --force to replace it`);
  }

  mkdirSync(draftDir, { recursive: true });

  // Probe every distinct source once, and copy it into the project.
  //
  // A draft that points at a temp path opens today and is broken tomorrow when
  // that path is cleaned up — CapCut shows "media offline" and the timeline is
  // useless. Copying makes the project self-contained, which is what CapCut
  // does for its own imports.
  mkdirSync(join(draftDir, "assets"), { recursive: true });
  const media = new Map();
  for (const src of new Set(edl.shots.map((s) => s.src))) {
    const info = await probeMedia(src);
    if (opts.copyMedia !== false) {
      const dest = join(draftDir, "assets", basename(src));
      if (!existsSync(dest)) copyFileSync(src, dest);
      info.path = dest;
    }
    media.set(src, info);
  }

  let music = null;
  if (edl.music?.path && existsSync(edl.music.path)) {
    const m = await probeMedia(edl.music.path);
    let mp = m.path;
    if (opts.copyMedia !== false) {
      const dest = join(draftDir, "assets", basename(edl.music.path));
      if (!existsSync(dest)) copyFileSync(edl.music.path, dest);
      mp = dest;
    }
    music = { path: mp, durationSec: m.durationSec };
  }

  const draft = edlToDraft(edl, { name, media, music, aspect: opts.aspect });

  // Validate BEFORE writing. CapCut will happily open a broken draft and show
  // an empty timeline, which is far harder to diagnose than a refusal here.
  const problems = validateDraft(draft);
  if (problems.length) {
    throw new Error(`generated draft failed validation:\n  - ${problems.join("\n  - ")}`);
  }

  // macOS CapCut reads `draft_info.json`; `draft_content.json` is written too
  // because other builds and every third-party tool look for that name.
  const doc = JSON.stringify(draft);
  writeFileSync(join(draftDir, "draft_info.json"), doc);
  writeFileSync(join(draftDir, "draft_content.json"), doc);
  // The per-project meta file is where CapCut reads the runtime it shows in the
  // library — it does NOT parse draft_content.json for it. `tm_duration` is the
  // key it reads; `draft_duration` is ignored, so a project written with that
  // name opens correctly and lists as 00:00.
  // Merged, not replaced. Once CapCut has opened a project it rewrites this file
  // into its own much larger schema; replacing it with our minimal version drops
  // fields the app put there.
  const metaPath = join(draftDir, "draft_meta_info.json");
  let priorMeta = {};
  if (existsSync(metaPath)) {
    try { priorMeta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { priorMeta = {}; }
  }
  // Once CapCut has seen the project it mints its own id. Keeping ours would
  // desync this file from the library index and hide the project again.
  const draftId = priorMeta.draft_id || draft.id;
  writeFileSync(
    metaPath,
    JSON.stringify({
      ...priorMeta,
      draft_id: draftId,
      draft_name: name,
      draft_fold_path: draftDir,
      draft_root_path: dir,
      draft_json_file: join(draftDir, "draft_content.json"),
      draft_cover: join(draftDir, "draft_cover.jpg"),
      draft_timeline_materials_size: 0,
      tm_draft_create: Date.now() * 1000,
      tm_draft_modified: Date.now() * 1000,
      tm_duration: draft.duration,
      draft_materials: [],
    }),
  );

  if (opts.cover && existsSync(opts.cover)) {
    try { copyFileSync(opts.cover, join(draftDir, "draft_cover.jpg")); } catch { /* cosmetic */ }
  }

  registerDraft(dir, draftDir, name, draft.duration, draftId);

  const segs = draft.tracks.find((t) => t.type === "video").segments.length;
  log.ok(`CapCut project "${name}" — ${segs} segments, ${(draft.duration / 1e6).toFixed(1)}s`);
  log.info(`  ${draftDir}`);
  return { dir: draftDir, name, segments: segs, durationUs: draft.duration };
}

export { us };
