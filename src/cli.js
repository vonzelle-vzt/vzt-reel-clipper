import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import kleur from "kleur";
import { log, slug } from "./util.js";
import { resolveInput } from "./resolve.js";
import { transcribeLocal, transcriptFromVttFile } from "./transcribe.js";
import { selectClips } from "./select.js";
import { selectSportsClips } from "./sports.js";
import { renderClip, stitchReel } from "./render.js";
import { planReframe } from "./reframe.js";
import { SPORT_KEYS, getProfile } from "./profiles.js";
import { GRADES } from "./grade.js";
import { ARCS, planEdit } from "./plan.js";
import { analyzeMusic, syntheticGrid } from "./music.js";
import { searchTracks, tempoFromPreview, nowPlaying } from "./applemusic.js";
import { scorePlays, findShots } from "./score.js";
import { renderReel, exportCover } from "./composite.js";
import { watchVideo, summarize, actionSpans, DENSITIES } from "./watch.js";
import { contactSheet } from "./inspect.js";
import { learnStyle, describeStyle, loadStyle, listStyles } from "./learn/index.js";
import { styleToPlanOpts, resolveRampCount } from "./learn/style.js";

function pkgVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

export async function run(argv) {
  const program = new Command();
  // Without this, the parent's own -o/--out swallows the same flag on the
  // `watch`/`inspect` subcommands and they silently use their defaults.
  program.enablePositionalOptions();
  program
    .name("vzt-reel-clipper")
    .version(pkgVersion(), "-v, --version", "print version")
    .description("Turn 1 longform video into N captioned vertical shorts (local, no paid API).")
    .argument("<input>", "local video file OR a YouTube/video URL")
    .option(
      "-m, --mode <mode>",
      "selection mode: speech (talking/podcast) | sports (game film → N clips) | hype (game film → 1 music-driven reel)",
      "speech",
    )
    .option("--sport <name>", `sport profile: ${SPORT_KEYS.join(" | ")}`, "generic")
    .option("--music <file>", "hype: music track that drives the edit (or use --bpm for a known track you can't export)")
    .option("--bpm <n>", "hype: cut to a known tempo without an audio file — for in-app audio (TikTok/Reels)", (v) => parseFloat(v))
    .option("--drop <sec>", "hype: where the drop lands in that track, for --bpm", (v) => parseFloat(v))
    .option("--apple-music <query>", "hype: resolve tempo from an Apple Music track's preview (like --bpm, but you don't have to know the number)")
    .option("--drop-from-music", "hype: read the drop from the Music app's current playhead (scrub to it, then run this)")
    .option("--sfx-dir <dir>", "hype: your sfx library, with whoosh/ impact/ riser/ subfolders")
    .option("--grade <name>", `hype: color grade: none | ${Object.keys(GRADES).join(" | ")}`, "punch")
    .option("--lut <file.cube>", "hype: 3D LUT to apply instead of a named grade")
    .option("--arc <name>", `hype: pacing arc: ${Object.keys(ARCS).join(" | ")}`)
    .option("--style <name>", "hype: cut in a style learned from a reference (see `reelclip learn`)")
    .option("--duration <sec>", "hype: cap the reel length", (v) => parseFloat(v))
    .option("--no-ramps", "hype: don't speed-ramp into the moment of impact")
    .option("--ramp-count <n>", "hype: how many plays get a speed ramp (default: ~35% of them)", (v) => parseInt(v, 10))
    .option("--ramp-speed <0..1>", "hype: slow-motion speed for ramps (higher = less slow, less judder)", (v) => parseFloat(v), 0.6)
    .option("--slowmo <mode>", "hype: slow-motion quality: dup (fast) | blend | smooth (interpolated, ~40x slower)", "dup")
    .option("--no-sfx", "hype: don't mix sound effects")
    .option(
      "--no-music-bed",
      "hype: cut TO the track but don't mix it in — export a silent master so you can add the official sound in-app (TikTok/Reels)",
    )
    .option("--ambience <0..1>", "hype: how much source audio sits under the music", (v) => parseFloat(v), 0.18)
    .option("-n, --count <n>", "number of clips to produce", (v) => parseInt(v, 10), 5)
    .option("-o, --out <dir>", "output directory", "clips")
    .option("--min <sec>", "minimum clip length (speech mode)", (v) => parseFloat(v), 18)
    .option("--max <sec>", "maximum clip length (speech mode)", (v) => parseFloat(v), 60)
    .option("-l, --language <iso>", "transcription language hint")
    .option("-e, --engine <name>", "LLM for moment selection: claude | codex", "claude")
    .option("--model <name>", "model override for the chosen engine (default: claude=sonnet, codex=its config default)")
    .option("--reel", "also stitch the clips into one highlight reel")
    .option("--preroll <sec>", "sports: seconds before each peak", (v) => parseFloat(v), 7)
    .option("--postroll <sec>", "sports: seconds after each peak", (v) => parseFloat(v), 4)
    .option("--sensitivity <n>", "sports: peak threshold (lower = more clips)", (v) => parseFloat(v), 1.0)
    .option("--cookies <file>", "cookies.txt for YouTube auth")
    .option("--cookies-from-browser <name>", "browser to read YouTube cookies from (firefox|edge|chrome)")
    .option("--proxy <url>", "proxy for the yt-dlp download, e.g. socks5://127.0.0.1:1080 or http://user:pass@host:port")
    .option("--font <name>", "caption font", "Arial")
    .option("--fit <mode>", "framing: cover (crop) | contain (pad) | blur (blurred fill) | smart (subject-tracking pan)", "cover")
    .option("--reframe-backend <name>", "smart reframe detector: motion (local, no model — best for sports) | onnx (local YOLO) | vintel (cloud) | mock", "motion")
    .option("--reframe-model <path>", "smart reframe: YOLOv8 .onnx model path (or set VZT_REFRAME_MODEL)")
    .option("--reframe-conf <0..1>", "smart reframe: detection confidence threshold", (v) => parseFloat(v), 0.35)
    .option("--reframe-fps <n>", "smart reframe: detection sample rate", (v) => parseFloat(v), 5)
    .option("--reframe-smooth <0..1>", "smart reframe: camera smoothing (higher = steadier)", (v) => parseFloat(v), 0.85)
    .option("--reframe-deadzone <px>", "smart reframe: ignore subject jitter under N source px", (v) => parseFloat(v), 24)
    .option("--zoom <n>", "smart reframe: crop tighter into the action (1 = full height, 1.5 = 33% tighter). For wide film shot from the stands.", (v) => parseFloat(v), 1)
    .option("--action-y <0..1>", "smart reframe: where the action band sits vertically (0.5 = centre, lower = higher up)", (v) => parseFloat(v), 0.5)
    .option("--reframe-letterbox <fit>", "smart reframe: fit for clips too wide to pan (blur|contain|cover)", "blur")
    .option("--no-reframe-audio-hold", "smart reframe: don't hold the camera during silence")
    .option("--no-reframe-active-speaker", "smart reframe: letterbox wide multi-person shots instead of following the talker")
    .option("--no-captions", "skip burned-in captions (just cut + reframe)")
    .action(main);

  // ------------------------------------------------------------- watch
  // Look at the footage BEFORE cutting it. Every selection bug found on real
  // film was invisible in the statistics and obvious in one frame.
  program
    .command("watch <input>")
    .description("watch a video: sample frames, read them, and report what is actually in it")
    .option("-d, --density <n>", `frames per second: ${Object.keys(DENSITIES).join(" | ")} or a number`, "normal")
    .option("--sport <name>", "sport, for the vision prompt", "sport")
    .option("-o, --out <dir>", "where to write frames + watch.json", "watch")
    .option("--no-describe", "measurement only — skip the model pass (zero tokens)")
    .option("--json", "print the raw timeline as JSON")
    .action(async (input, o) => {
      const outDir = resolvePath(o.out);
      mkdirSync(outDir, { recursive: true });
      log.step("Resolving input");
      const { videoPath } = await resolveInput(input, join(outDir, ".work"), {});
      const w = await watchVideo(videoPath, outDir, {
        density: o.density,
        sport: o.sport,
        describe: o.describe,
      });
      if (o.json) {
        console.log(JSON.stringify(w, null, 2));
        return;
      }
      console.log(summarize(w));
      const spans = actionSpans(w);
      if (spans.length) {
        console.log(kleur.bold("\n  Live action found at:"));
        for (const s of spans) console.log(kleur.gray(`    ${s.start.toFixed(1)}-${s.end.toFixed(1)}s  (${(s.end - s.start).toFixed(1)}s)`));
      }
      console.log(kleur.gray(`\n  timeline: ${join(outDir, "watch.json")}`));
      if (w.sheet) console.log(kleur.gray(`  sheet:    ${w.sheet}`));
      console.log();
    });

  // ------------------------------------------------------------ inspect
  program
    .command("inspect <input>")
    .description("contact sheet only — a fast look, no model call, zero tokens")
    .option("-t, --tiles <n>", "how many frames to tile", (v) => parseInt(v, 10), 30)
    .option("-o, --out <file>", "output image", "contact.jpg")
    .action(async (input, o) => {
      const out = resolvePath(o.out);
      const { videoPath } = await resolveInput(input, dirname(out), {});
      await contactSheet(videoPath, out, { tiles: o.tiles });
    });

  // -------------------------------------------------------------- music
  // Apple Music helpers: look up a track's preview/tempo, or read the Music
  // app's own playhead — see src/applemusic.js for why both exist.
  const music = program.command("music").description("Apple Music: tempo lookup + now-playing position");
  music
    .command("search <query>")
    .description("search Apple Music (iTunes Search API) for a track")
    .option("-n, --limit <n>", "how many results", (v) => parseInt(v, 10), 5)
    .action(async (query, o) => {
      const results = await searchTracks(query, { limit: o.limit });
      results.forEach((r, i) =>
        console.log(
          kleur.gray(`   ${i + 1}. `) +
            kleur.bold(`${r.trackName} — ${r.artistName}`) +
            kleur.gray(` (${r.collectionName}, ${r.durationSec ? r.durationSec.toFixed(0) + "s" : "?"})`) +
            (r.previewUrl ? kleur.green(" · preview available") : kleur.yellow(" · no preview")),
        ),
      );
    });
  music
    .command("now")
    .description("print the track + position currently playing in Music.app")
    .action(async () => {
      const np = await nowPlaying();
      if (!np) return;
      console.log(kleur.bold(`${np.name} — ${np.artist}`) + kleur.gray(`  @ ${np.position.toFixed(2)}s`));
    });

  // -------------------------------------------------------------- learn
  program
    .command("learn <input>")
    .description("learn an editing style from a reference reel (URL or file)")
    .option("-n, --name <name>", "what to call this style", "reference")
    .option("--sport <name>", "sport, for the vision prompt", "sport")
    .option("--keep-video", "don't delete the downloaded reference after measuring")
    .option("--no-describe", "skip the vision pass (no shot classification)")
    .action(async (input, o) => {
      const { style, stylePath, sheet } = await learnStyle(input, {
        name: o.name,
        sport: o.sport,
        describe: o.describe,
        keepVideo: o.keepVideo,
        workDir: join(resolvePath("."), ".learn"),
      });
      console.log(describeStyle(style));
      console.log(kleur.gray(`\n  style: ${stylePath}`));
      console.log(kleur.gray(`  sheet: ${sheet}`));
      console.log(kleur.gray(`\n  use it:  reelclip <film> --mode hype --style ${style.name}\n`));
    });

  program
    .command("styles")
    .description("list the styles that have been learned")
    .action(() => {
      const names = listStyles();
      if (!names.length) {
        console.log(kleur.gray("  no styles yet — run: reelclip learn <url> --name <name>"));
        return;
      }
      for (const n of names) {
        const st = loadStyle(n);
        console.log(`  ${kleur.bold(n.padEnd(16))} ${st.music.bpm ?? "?"} BPM · arc ${st.pacing.arc} · ${st.pacing.shots} shots`);
      }
    });

  await program.parseAsync(argv);
}

async function main(input, opts, command) {
  const t0 = Date.now();
  if (!["claude", "codex"].includes(opts.engine)) {
    throw new Error(`--engine must be "claude" or "codex" (got "${opts.engine}")`);
  }
  if (!["cover", "contain", "blur", "smart"].includes(opts.fit)) {
    throw new Error(`--fit must be "cover", "contain", "blur", or "smart" (got "${opts.fit}")`);
  }
  if (!["speech", "sports", "hype"].includes(opts.mode)) {
    throw new Error(`--mode must be "speech", "sports", or "hype" (got "${opts.mode}")`);
  }
  if (opts.mode === "hype" && !opts.music && !opts.bpm && !opts.appleMusic) {
    throw new Error(
      "--mode hype needs a beat grid. Either:\n" +
        "  --music <file.mp3>            analyze a track you have on disk, or\n" +
        "  --bpm <n> [--drop <sec>]      cut to a known tempo with no file — for in-app audio, or\n" +
        "  --apple-music <query>         resolve tempo from an Apple Music preview\n" +
        "The grid drives the edit: cuts land on its beats and the best play lands on its drop.",
    );
  }
  if (opts.bpm && opts.music) {
    throw new Error("pass either --music or --bpm, not both");
  }
  if (opts.appleMusic && opts.music) {
    throw new Error("pass either --music or --apple-music, not both");
  }
  if (opts.appleMusic && opts.bpm) {
    throw new Error("pass either --apple-music or --bpm, not both");
  }
  // A synthetic grid has no audio to mix, so the output is silent by design.
  if ((opts.bpm || opts.appleMusic) && opts.musicBed !== false) {
    log.warn("--bpm/--apple-music has no audio to mix — exporting a silent master (add the sound in-app)");
  }
  const outDir = resolvePath(opts.out);
  const workDir = join(outDir, ".work");
  mkdirSync(workDir, { recursive: true });

  // 1. Resolve input → local video (+ maybe word-level VTT).
  log.step("Resolving input");
  const { videoPath, vttPath, title } = await resolveInput(input, workDir, {
    cookiesFile: opts.cookies,
    cookiesFromBrowser: opts.cookiesFromBrowser,
    proxy: opts.proxy,
  });
  log.ok(`source: ${videoPath}`);

  // ---------------------------------------------------------------- hype
  // One music-driven reel rather than N standalone clips. Analysis feeds an
  // EDL (plan.js) and the compositor renders it; see docs/ARCHITECTURE.md.
  if (opts.mode === "hype") {
    const profile = getProfile(opts.sport);

    log.step(opts.bpm ? "Building beat grid" : opts.appleMusic ? "Resolving tempo from Apple Music" : "Analyzing music");
    // --drop-from-music reads the Music app's playhead, which requires you to
    // have the real track cued up and scrubbed to the drop — that position is
    // the only trustworthy source for a DRM-protected track's drop timestamp
    // (see src/applemusic.js for why the preview's own drop can't be used).
    let drop = opts.drop ?? null;
    if (opts.dropFromMusic) {
      const np = await nowPlaying();
      if (np) {
        drop = np.position;
        log.ok(`drop @ ${np.position.toFixed(1)}s (from Music: ${np.name} — ${np.artist})`);
      }
    }
    let music;
    if (opts.appleMusic) {
      const resolved = await tempoFromPreview(opts.appleMusic, workDir);
      log.ok(`${resolved.track.trackName} — ${resolved.track.artistName} · ${resolved.bpm} BPM (from 30s preview)`);
      music = syntheticGrid(resolved.bpm, { drop, duration: (opts.duration || 60) + 30 });
    } else if (opts.bpm) {
      music = syntheticGrid(opts.bpm, { drop, duration: (opts.duration || 60) + 30 });
    } else {
      music = await analyzeMusic(opts.music);
    }

    log.step(`Scoring plays (${profile.label})`);
    const plays = await scorePlays(videoPath, {
      sport: opts.sport,
      count: opts.count > 5 ? opts.count : 10,
      sensitivity: opts.sensitivity,
    });
    plays.forEach((p) => (p.src = videoPath));
    plays.forEach((c, i) =>
      console.log(kleur.gray(`   ${i + 1}. [${c.start.toFixed(1)}-${c.end.toFixed(1)}] `) + kleur.bold(c.title) + kleur.gray(`  ${c.reason}`)),
    );

    log.step("Finding B-roll and a closing shot");
    const broll = await findShots(videoPath, profile.broll, { count: 8, region: [0, 0.25] });
    const outro = await findShots(videoPath, profile.outro, { count: 2, len: 2.5, region: [0.85, 1] });
    log.ok(`${broll.length} b-roll, ${outro.length} closing candidate(s)`);

    // A learned style supplies defaults; an explicit flag always beats it, and
    // the run prints which values came from where. A style that silently
    // overrode a typed flag would be the same class of problem as reporting a
    // number nobody measured.
    let style = null;
    let styleOpts = {};
    let provenance = {};
    if (opts.style) {
      style = loadStyle(opts.style);
      const explicit = {
        arc: opts.arc,
        // Only treat --grade as explicit when the user actually typed it;
        // otherwise its default would always beat the learned style.
        grade: opts.lut ? "none" : (command?.getOptionValueSource?.("grade") === "cli" ? opts.grade : null),
        rampCount: opts.rampCount,
      };
      ({ opts: styleOpts, provenance } = styleToPlanOpts(style, explicit));
      styleOpts.rampCount = resolveRampCount(style, plays.length, opts.rampCount);
      const from = Object.entries(provenance).map(([k, v]) => `${k}:${v}`).join(" ");
      log.info(`style "${style.name}" → ${from}`);
    }

    log.step("Planning the edit");
    const edl = planEdit({
      music,
      plays,
      broll,
      outro,
      sport: opts.sport,
      opts: {
        arc: styleOpts.arc ?? opts.arc ?? "rollercoaster",
        minShotBeats: styleOpts.minShotBeats,
        grade: opts.lut ? "none" : (styleOpts.grade ?? opts.grade),
        ramps: opts.ramps,
        rampCount: styleOpts.rampCount ?? opts.rampCount,
        rampSpeed: opts.rampSpeed,
        maxDuration: opts.duration,
        transitions: true,
      },
    });
    // Framing and LUT are render concerns the planner doesn't own.
    edl.shots.forEach((s) => {
      s.fit = opts.fit;
      s.lut = opts.lut || null;
    });
    // Per-shot smart reframe: plan a camera path for each shot so the 9:16
    // window follows the play instead of centre-cropping it away. Wide sports
    // film is exactly the case that needs it — a fixed centre crop throws away
    // a third of the field on each side.
    if (opts.fit === "smart") {
      log.step("Planning camera paths");
      let panned = 0;
      let boxed = 0;
      for (const s of edl.shots) {
        const rf = await planReframe(s.src, { start: s.srcStart, end: s.srcEnd }, {
          fps: opts.reframeFps,
          smooth: opts.reframeSmooth,
          deadzone: opts.reframeDeadzone,
          backend: opts.reframeBackend,
          modelPath: opts.reframeModel,
          confThres: opts.reframeConf,
          letterboxFit: opts.reframeLetterbox,
          zoom: opts.zoom,
          yFrac: opts.actionY,
          audioHold: opts.reframeAudioHold,
          activeSpeaker: opts.reframeActiveSpeaker,
          workDir,
        });
        if (rf?.recommendFit) {
          // Can't pan without cutting someone out — letterbox this shot only.
          s.fit = rf.recommendFit;
          s.reframe = null;
          boxed++;
        } else if (rf) {
          s.reframe = rf;
          panned++;
        } else {
          s.fit = "cover";
          s.reframe = null;
          boxed++;
        }
      }
      log.ok(`${panned} shot(s) tracked, ${boxed} letterboxed/centred`);
    }
    console.log(
      kleur.gray(`   ${edl.shots.length} shots · ${edl.duration.toFixed(1)}s · ${edl.bpm} BPM · arc ${edl.arc}`) +
        (music.drop != null ? kleur.gray(` · hook on drop @ ${music.drop.toFixed(1)}s`) : kleur.yellow(" · no drop detected")),
    );
    writeFileSync(join(outDir, "edl.json"), JSON.stringify(edl, null, 2));

    // `--no-music-bed`: the track still drives every cut, it just isn't mixed
    // into the output. TikTok/Reels license their in-app libraries for in-app
    // use only, so a trending sound cannot legally be burned into an exported
    // file — and native audio gets better distribution anyway. Cut to your copy
    // of the track, export silent, then pick the same official sound in-app and
    // the edit lines up because it is the same recording.
    if (opts.musicBed === false) {
      edl.music = { ...edl.music, path: null };
      log.info("silent master: cutting to the track but not mixing it — add the official sound in-app");
    }

    const reel = await renderReel(edl, outDir, {
      sfxDir: opts.sfx === false ? null : opts.sfxDir,
      ambience: opts.ambience,
      slowmo: opts.slowmo,
      name: "00-hype-reel",
    });
    const cover = await exportCover(reel.file, outDir, edl.cover);

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      "\n" +
        kleur.green().bold(`Done — ${reel.duration.toFixed(1)}s hype reel in ${secs}s`) +
        kleur.gray(`\n  ${reel.file}\n  cover: ${cover}\n  edl: ${join(outDir, "edl.json")}`),
    );
    return;
  }

  const sports = opts.mode === "sports";
  let clips;
  let words = []; // word-by-word captions (speech mode only)

  if (sports) {
    // Game film / no-speech: find plays by audio-energy peaks (no transcript).
    log.step("Finding plays (audio energy)");
    clips = await selectSportsClips(videoPath, {
      count: opts.count,
      preroll: opts.preroll,
      postroll: opts.postroll,
      sensitivity: opts.sensitivity,
    });
    log.ok(`${clips.length} plays detected`);
  } else {
    // 2. Transcript — prefer real word-level VTT, else local WASM whisper.
    log.step("Transcribing");
    let transcript;
    if (vttPath && existsSync(vttPath)) {
      transcript = transcriptFromVttFile(vttPath);
      log.ok(`word-level captions from YouTube (${transcript.words.length} words, ${transcript.segments.length} segments)`);
    } else {
      // Cache the (slow, ~15 min) WASM-whisper transcript in .work so re-runs —
      // e.g. changing --count or --fit — skip straight to selection/render.
      const cachePath = join(workDir, "transcript.json");
      if (existsSync(cachePath)) {
        transcript = JSON.parse(readFileSync(cachePath, "utf8"));
        log.ok(`${transcript.segments.length} segments (cached transcript — skipped transcription)`);
      } else {
        transcript = await transcribeLocal(videoPath, { language: opts.language });
        writeFileSync(cachePath, JSON.stringify(transcript), "utf8");
        log.ok(`${transcript.segments.length} segments (${transcript.words.length} words, timing approximated)`);
      }
    }
    if (!transcript.segments.length) {
      throw new Error(
        "no speech found — for game film / silent video use --mode sports (audio-energy selection)",
      );
    }
    words = transcript.words;

    // 3. Pick the best moments via claude CLI.
    log.step("Selecting clips");
    clips = await selectClips(transcript.segments, {
      count: opts.count,
      minLen: opts.min,
      maxLen: opts.max,
      engine: opts.engine,
      model: opts.model,
    });
    log.ok(`${clips.length} clips chosen`);
  }

  clips.forEach((c, i) =>
    console.log(kleur.gray(`   ${i + 1}. [${c.start.toFixed(1)}-${c.end.toFixed(1)}] `) + kleur.bold(c.title)),
  );

  // 4. Render each clip.
  log.step("Rendering vertical clips");
  const results = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const name = `${String(i + 1).padStart(2, "0")}-${slug(c.title)}`;
    // Plan the subject-tracking camera path (null → renderClip falls back to cover).
    let reframe = null;
    let fit = opts.fit;
    if (opts.fit === "smart") {
      reframe = await planReframe(videoPath, c, {
        fps: opts.reframeFps,
        smooth: opts.reframeSmooth,
        deadzone: opts.reframeDeadzone,
        backend: opts.reframeBackend,
        modelPath: opts.reframeModel,
        confThres: opts.reframeConf,
        letterboxFit: opts.reframeLetterbox,
        audioHold: opts.reframeAudioHold, // --no-reframe-audio-hold → false
        activeSpeaker: opts.reframeActiveSpeaker, // --no-reframe-active-speaker → false
        workDir,
      });
      // Wide multi-subject clip: pan would cut someone — letterbox the whole clip.
      if (reframe?.recommendFit) {
        log.info(`smart reframe: ${reframe.reason} → rendering as ${reframe.recommendFit}`);
        fit = reframe.recommendFit;
        reframe = null;
      }
    }
    const file = await renderClip(
      videoPath,
      c,
      opts.captions ? words : [],
      outDir,
      name,
      { caption: { font: opts.font }, fit, reframe, staticTitle: sports && opts.captions ? c.title : null },
    );
    results.push({ ...c, file });
    log.ok(`#${i + 1} → ${file}`);
  }

  // 4b. Optional stitched highlight reel.
  if (opts.reel && results.length) {
    log.step("Stitching highlight reel");
    const reel = await stitchReel(results.map((r) => r.file), outDir, "00-highlight-reel");
    log.ok(`reel → ${reel}`);
  }

  // 5. Manifest.
  writeFileSync(
    join(outDir, "clips.json"),
    JSON.stringify({ source: input, title, generated: new Date().toISOString(), clips: results }, null, 2),
  );

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    "\n" +
      kleur.green().bold(`Done — ${results.length} clips in ${secs}s`) +
      kleur.gray(`\n  ${outDir}\n  manifest: clips.json`),
  );
}
