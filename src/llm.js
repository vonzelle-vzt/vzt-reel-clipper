import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./util.js";

/**
 * Run a text prompt through a local LLM CLI and return its text response.
 * Both engines use the user's existing subscription/login — no API key, no
 * per-call billing here.
 *
 *   engine "claude"  → `claude -p` (default model: sonnet)
 *   engine "codex"   → `codex exec` (default model: codex's own config default)
 *
 * @param {string} prompt
 * @param {{engine?: string, model?: string|null}} opts
 * @returns {Promise<string>} the model's raw text output
 */
export async function runLLM(prompt, { engine = "claude", model = null } = {}) {
  if (engine === "claude") return runClaude(prompt, model);
  if (engine === "codex") return runCodex(prompt, model);
  throw new Error(`unknown engine "${engine}" (use "claude" or "codex")`);
}

async function runClaude(prompt, model) {
  const args = ["-p", "--model", model || "sonnet"];
  const { stdout, code, stderr } = await exec("claude", args, {
    stdin: prompt,
    shell: process.platform === "win32",
  });
  if (code !== 0) throw new Error(`claude CLI failed (exit ${code}).\n${stderr.slice(-1000)}`);
  return stdout;
}

async function runCodex(prompt, model) {
  // `codex exec` reads the prompt from stdin and writes its final message to a
  // file (clean, no agent chatter). read-only sandbox: it's a pure text task.
  const dir = mkdtempSync(join(tmpdir(), "reelclip-codex-"));
  const outFile = join(dir, "out.txt");
  const args = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-o", outFile];
  if (model) args.push("-m", model);
  try {
    const { code, stdout, stderr } = await exec("codex", args, {
      stdin: prompt,
      shell: process.platform === "win32",
    });
    let out = "";
    try {
      out = readFileSync(outFile, "utf8");
    } catch {
      out = stdout; // fall back to stdout if the file wasn't written
    }
    if (!out.trim() && code !== 0) {
      throw new Error(`codex exec failed (exit ${code}).\n${stderr.slice(-1000)}`);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Friendly default-model label for logging. */
export function engineLabel(engine, model) {
  if (engine === "codex") return `codex${model ? ` (${model})` : ""}`;
  return `claude (${model || "sonnet"})`;
}
