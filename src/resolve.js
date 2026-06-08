import { existsSync, readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { exec, log } from "./util.js";

const YT_RE = /(youtube\.com|youtu\.be)/i;

export function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

/**
 * Resolve the CLI input into a local video file + optional word-level VTT + title.
 * Local paths pass straight through. YouTube URLs are downloaded via yt-dlp.
 */
export async function resolveInput(input, workDir, opts = {}) {
  if (!isUrl(input)) {
    if (!existsSync(input)) throw new Error(`file not found: ${input}`);
    return { videoPath: input, vttPath: null, title: basename(input, extname(input)) };
  }
  if (!YT_RE.test(input)) {
    // Generic URL — try yt-dlp anyway (it supports many sites).
    log.warn("non-YouTube URL — attempting download via yt-dlp");
  }
  return downloadYoutube(input, workDir, opts);
}

async function downloadYoutube(url, workDir, opts = {}) {
  log.step("Downloading source video (yt-dlp)");
  const denoDir = join(process.env.USERPROFILE || process.env.HOME || "", ".deno", "bin");
  const env = existsSync(denoDir)
    ? { PATH: `${denoDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` }
    : {};

  const base = join(workDir, "source");
  const args = [
    "--js-runtimes", "deno",
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
    "--merge-output-format", "mp4",
    "--write-auto-subs", "--sub-langs", "en.*", "--sub-format", "vtt",
    "-o", `${base}.%(ext)s`,
  ];
  // Cookie source for YouTube's bot check. Default: from Edge; overridable.
  if (opts.cookiesFile) args.push("--cookies", opts.cookiesFile);
  else if (opts.cookiesFromBrowser) args.push("--cookies-from-browser", opts.cookiesFromBrowser);
  args.push(url);

  const { code, stderr } = await exec("yt-dlp", args, {
    env,
    onStdout: (d) => process.stdout.write(d),
  });
  if (code !== 0) {
    const hint = /Sign in to confirm|cookies|DPAPI/i.test(stderr)
      ? "\n\nYouTube needs browser cookies. Try: --cookies-from-browser firefox  OR export cookies.txt and pass --cookies <file>. (Edge/Chrome cookie decryption often fails on Windows due to app-bound encryption — close the browser or use Firefox.)"
      : "";
    throw new Error(`yt-dlp failed (exit ${code}).\n${stderr.slice(-1500)}${hint}`);
  }

  // Find the produced video + vtt.
  const files = readdirSync(workDir);
  const video = files.find((f) => f.startsWith("source.") && /\.(mp4|mkv|webm)$/i.test(f));
  const vtt = files.find((f) => f.startsWith("source.") && f.endsWith(".vtt"));
  if (!video) throw new Error("yt-dlp finished but no video file was produced");
  log.ok(`downloaded ${video}${vtt ? ` (+ word-level captions ${vtt})` : " (no auto-subs — will transcribe locally)"}`);
  return {
    videoPath: join(workDir, video),
    vttPath: vtt ? join(workDir, vtt) : null,
    title: "youtube-clip",
  };
}
