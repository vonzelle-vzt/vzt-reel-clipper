import { spawn } from "node:child_process";
import kleur from "kleur";

export const log = {
  step: (m) => console.log(kleur.bold().cyan("▸ ") + kleur.bold(m)),
  info: (m) => console.log(kleur.gray("  " + m)),
  ok: (m) => console.log(kleur.green("  ✓ ") + m),
  warn: (m) => console.log(kleur.yellow("  ! " + m)),
};

/**
 * Run a command, streaming nothing, returning {code, stdout, stderr}.
 * Never rejects on non-zero exit unless opts.check is true.
 */
export function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: opts.shell || false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    child.stdout.on("data", (d) => {
      stdout += d;
      if (opts.onStdout) opts.onStdout(d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (opts.onStderr) opts.onStderr(d.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (opts.check && code !== 0) {
        reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2000)}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

export async function ffprobeDuration(path) {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { check: true },
  );
  return parseFloat(stdout.trim());
}

export function fmtClock(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const cs = Math.round((rest - Math.floor(rest)) * 100);
  const ss = Math.floor(rest);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function slug(s, max = 40) {
  return (s || "clip")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "clip";
}
