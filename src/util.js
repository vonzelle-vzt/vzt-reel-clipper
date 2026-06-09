import { spawn } from "node:child_process";
import kleur from "kleur";

export const log = {
  step: (m) => console.log(kleur.bold().cyan("▸ ") + kleur.bold(m)),
  info: (m) => console.log(kleur.gray("  " + m)),
  ok: (m) => console.log(kleur.green("  ✓ ") + m),
  warn: (m) => console.log(kleur.yellow("  ! " + m)),
};

/**
 * Quote a single argument for safe use when `spawn` runs through a shell.
 * Node does NOT auto-quote args in shell mode, so a path containing spaces
 * (e.g. "…/2026 Matrix Bootcamp/Day 1 - EMAS.mp4") gets split by the shell.
 * Non-shell calls pass args as an array and never need this.
 */
export function quoteArg(arg) {
  const s = String(arg);
  if (s === "") return '""';
  if (process.platform === "win32") {
    // cmd.exe: only quote when needed; escape embedded double quotes as "".
    if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  // POSIX sh: single-quote and escape embedded single quotes.
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Run a command, streaming nothing, returning {code, stdout, stderr}.
 * Never rejects on non-zero exit unless opts.check is true.
 */
export function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const useShell = opts.shell || false;
    // In shell mode Node joins args with spaces and runs them through the
    // shell without quoting, so quote each arg ourselves. Array-mode (no
    // shell) passes args verbatim and must be left untouched.
    const spawnArgs = useShell ? args.map(quoteArg) : args;
    const child = spawn(cmd, spawnArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: useShell,
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
