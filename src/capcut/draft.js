import { randomUUID } from "node:crypto";
import { basename } from "node:path";

/**
 * EDL → CapCut draft.
 *
 * CapCut has no public API — its "Open Platform" only builds plugins that run
 * inside the editor — but a CapCut project is a JSON file on disk, so writing
 * that file *is* editing the timeline. It is also strictly better than driving
 * the UI: clicking a timeline was measured here at frame-accurate positioning
 * but unreliable execution, because CapCut's own toasts render over the
 * timeline and swallow clicks. Writing timestamps has no such failure mode.
 *
 * This module is PURE — EDL in, draft object out, no filesystem. Everything
 * that touches disk lives in ./install.js, which keeps the schema mapping
 * unit-testable without a CapCut install.
 *
 * Two invariants that are easy to get wrong and produce a silently broken
 * project:
 *
 *   1. CapCut's timebase is MICROSECONDS. Our EDL is in seconds. Every
 *      boundary crosses that conversion exactly once.
 *   2. A segment's `source_timerange` is where to read from the MEDIA, while
 *      `target_timerange` is where it sits on the TIMELINE. Confusing them
 *      yields a project that opens fine and plays the wrong footage.
 *
 * Schema targeted: CapCut International 9.x on macOS. It is undocumented and
 * an app update can migrate it, so `install.js` verifies before writing.
 */

/** CapCut counts time in microseconds. */
export const US = 1_000_000;

/** Seconds → microseconds, rounded to an integer (CapCut rejects floats here). */
export function us(seconds) {
  return Math.max(0, Math.round((seconds || 0) * US));
}

const uid = () => randomUUID();

/**
 * Canvas sizes CapCut accepts, keyed by the ratio our CLI speaks.
 *
 * This matters more than it looks: the canvas decides how much of a 16:9 source
 * survives. A 1920-wide frame placed on a 9:16 canvas keeps roughly a third of
 * its width, so wide-field sports footage loses the action to the crop. 16:9
 * keeps all of it.
 */
export const ASPECTS = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

/** The material buckets CapCut expects to exist, even when empty. */
function emptyMaterials() {
  return {
    videos: [], audios: [], texts: [], stickers: [], video_effects: [],
    transitions: [], masks: [], chromas: [], audio_fades: [], audio_effects: [],
    canvases: [], speeds: [], sound_channel_mappings: [], vocal_separations: [],
    placeholders: [], common_mask: [],
  };
}

/**
 * Build a CapCut draft from an EDL.
 *
 * @param {object} edl        from src/plan.js
 * @param {object} opts
 * @param {string} opts.name          project name shown in CapCut
 * @param {Map<string,object>} opts.media  src path → { path, durationSec, width, height }
 * @param {object} [opts.music]       { path, durationSec } for the bed
 * @param {string} [opts.aspect]      canvas ratio; see ASPECTS
 * @returns {object} draft_content / draft_info document
 */
export function edlToDraft(edl, { name = "vzt-hype-reel", media, music = null, aspect = "9:16" } = {}) {
  if (!edl?.shots?.length) throw new Error("EDL has no shots to write");
  if (!media || !media.size) throw new Error("no media map — cannot resolve source paths");

  const materials = emptyMaterials();
  const videoSegments = [];
  const audioSegments = [];

  // One video material per distinct source file, reused by every segment cut
  // from it. CapCut keys segments to materials by id, so a 15-shot reel from
  // one file references a single material rather than fifteen copies.
  const materialForSrc = new Map();
  for (const [src, info] of media) {
    const id = uid();
    materialForSrc.set(src, id);
    materials.videos.push({
      id,
      type: "video",
      material_name: basename(info.path || src),
      path: info.path || src,
      duration: us(info.durationSec),
      width: info.width ?? 1920,
      height: info.height ?? 1080,
      has_audio: info.hasAudio !== false,
    });
  }

  edl.shots.forEach((shot, i) => {
    const materialId = materialForSrc.get(shot.src);
    if (!materialId) return;

    const srcDur = Math.max(0.04, shot.srcEnd - shot.srcStart);

    // A ramped shot plays a shorter source window across a longer slot. CapCut
    // expresses that as a single `speed` per segment, so the whole shot carries
    // the average rate rather than our three-part ramp — the segment lands on
    // the right beat either way, and the ramp curve is refined in CapCut where
    // its speed editor is better than anything we would emit blind.
    const speed = +(srcDur / Math.max(0.04, shot.dur)).toFixed(4);

    const speedId = uid();
    materials.speeds.push({ id: speedId, type: "speed", speed, mode: 0, curve_speed: null });

    videoSegments.push({
      id: uid(),
      material_id: materialId,
      target_timerange: { start: us(shot.at), duration: us(shot.dur) },
      source_timerange: { start: us(shot.srcStart), duration: us(srcDur) },
      clip: {
        rotation: 0,
        alpha: 1,
        scale: { x: 1, y: 1 },
        transform: { x: 0, y: 0 },
        flip: { horizontal: false, vertical: false },
      },
      speed,
      volume: shot.mute ? 0 : 1,
      visible: true,
      render_index: i,
      render_uniform_index: -1,
      extra_material_refs: [speedId],
      common_keyframes: [],
      uniform_scale: { on: true, value: 1 },
      group_id: "",
    });
  });

  // Music bed as its own track, trimmed to the picture.
  if (music?.path) {
    const musicId = uid();
    materials.audios.push({
      id: musicId,
      type: "extract_music",
      name: basename(music.path),
      path: music.path,
      duration: us(music.durationSec ?? edl.duration),
      wave_points: [],
      category_id: "",
      category_name: "local",
      music_id: "",
    });
    audioSegments.push({
      id: uid(),
      material_id: musicId,
      target_timerange: { start: 0, duration: us(edl.duration) },
      source_timerange: { start: us(edl.music?.offset || 0), duration: us(edl.duration) },
      speed: 1,
      volume: 1,
      visible: true,
      render_index: 0,
      extra_material_refs: [],
      common_keyframes: [],
      group_id: "",
    });
  }

  const tracks = [
    { id: uid(), type: "video", name: "main", attribute: 0, flag: 0, segments: videoSegments },
  ];
  if (audioSegments.length) {
    tracks.push({ id: uid(), type: "audio", name: "music", attribute: 0, flag: 0, segments: audioSegments });
  }

  return {
    id: uid(),
    name,
    duration: us(edl.duration),
    fps: 30,
    canvas_config: { ...(ASPECTS[aspect] || ASPECTS["9:16"]), ratio: ASPECTS[aspect] ? aspect : "9:16" },
    platform: { app_source: "cc", app_version: "9.2.0", os: "mac" },
    create_time: 0,
    update_time: 0,
    version: 360000,
    new_version: "110.0.0",
    materials,
    tracks,
    extra_info: { created_via: "vzt-reel-clipper" },
  };
}

/**
 * Assert the draft is internally consistent BEFORE it is written.
 *
 * A malformed draft does not error — CapCut opens it and shows the wrong
 * footage, or an empty timeline, which is far harder to debug than a refusal.
 *
 * @returns {string[]} problems; empty means the draft is sane
 */
export function validateDraft(draft) {
  const problems = [];
  const videoTrack = draft.tracks?.find((t) => t.type === "video");
  if (!videoTrack?.segments?.length) problems.push("no video segments");

  const ids = new Set((draft.materials?.videos || []).map((m) => m.id));
  let prevEnd = -1;
  for (const [i, seg] of (videoTrack?.segments || []).entries()) {
    if (!ids.has(seg.material_id)) problems.push(`segment ${i} references a missing material`);
    if (!Number.isInteger(seg.target_timerange.start)) problems.push(`segment ${i} start is not an integer µs`);
    if (seg.target_timerange.duration <= 0) problems.push(`segment ${i} has no duration`);
    if (seg.source_timerange.duration <= 0) problems.push(`segment ${i} reads no source`);
    // Segments must lay end-to-end. A gap plays black; an overlap is undefined.
    if (prevEnd >= 0 && seg.target_timerange.start !== prevEnd) {
      problems.push(`segment ${i} starts at ${seg.target_timerange.start}µs, previous ended at ${prevEnd}µs`);
    }
    prevEnd = seg.target_timerange.start + seg.target_timerange.duration;
  }
  if (videoTrack?.segments?.length && prevEnd !== draft.duration) {
    problems.push(`timeline ends at ${prevEnd}µs but duration says ${draft.duration}µs`);
  }
  return problems;
}
