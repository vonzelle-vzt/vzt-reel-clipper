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
  program
    .name("vzt-reel-clipper")
    .version(pkgVersion(), "-v, --version", "print version")
    .description("Turn 1 longform video into N captioned vertical shorts (local, no paid API).")
    .argument("<input>", "local video file OR a YouTube/video URL")
    .option("-m, --mode <mode>", "selection mode: speech (talking/podcast) | sports (game film, audio-energy)", "speech")
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
    .option("--font <name>", "caption font", "Arial")
    .option("--fit <mode>", "framing: cover (crop to fill) | contain (pad, nothing cut) | blur (fit + blurred fill)", "cover")
    .option("--no-captions", "skip burned-in captions (just cut + reframe)")
    .action(main);

  await program.parseAsync(argv);
}

async function main(input, opts) {
  const t0 = Date.now();
  if (!["claude", "codex"].includes(opts.engine)) {
    throw new Error(`--engine must be "claude" or "codex" (got "${opts.engine}")`);
  }
  if (!["cover", "contain", "blur"].includes(opts.fit)) {
    throw new Error(`--fit must be "cover", "contain", or "blur" (got "${opts.fit}")`);
  }
  const outDir = resolvePath(opts.out);
  const workDir = join(outDir, ".work");
  mkdirSync(workDir, { recursive: true });

  // 1. Resolve input → local video (+ maybe word-level VTT).
  log.step("Resolving input");
  const { videoPath, vttPath, title } = await resolveInput(input, workDir, {
    cookiesFile: opts.cookies,
    cookiesFromBrowser: opts.cookiesFromBrowser,
  });
  log.ok(`source: ${videoPath}`);

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
    const file = await renderClip(
      videoPath,
      c,
      opts.captions ? words : [],
      outDir,
      name,
      { caption: { font: opts.font }, fit: opts.fit, staticTitle: sports && opts.captions ? c.title : null },
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
