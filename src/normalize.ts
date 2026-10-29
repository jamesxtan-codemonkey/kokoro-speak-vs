// Text normalization: rewrite text into a speech-friendly form before synthesis.
// Runs in the extension host. Three modes (kokoroSpeak.normalization.mode):
//   off           — no normalization
//   deterministic — built-in regex rules + user replacements (offline, instant)
//   ai            — an LLM applies the natural-language rules; deterministic is
//                   the fallback when the backend is unavailable or fails.
// No `vscode` import — unit-testable in Node. The rules themselves and the
// Anthropic API call live in core/normalize.ts, shared with the Chrome
// extension; this file adds the Node-only CLI backends and a cache.

import { spawn, spawnSync, ChildProcess, SpawnOptions } from "child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, join } from "path";
import {
  NormMode,
  Replacement,
  aiNormalize,
  anthropicCall,
  deterministic,
  preNormalize,
  stripWrapping,
} from "./core/normalize";

export {
  applyReplacements,
  applySpellOut,
  deterministic,
  hasCandidates,
  stripEmphasis,
  SEED_RULES,
} from "./core/normalize";
export type { NormMode, Replacement } from "./core/normalize";

const IS_WIN = process.platform === "win32";

export type Backend = "auto" | "cli" | "api";

export interface NormalizeOptions {
  mode: NormMode;
  rules: string;
  replacements: Replacement[];
  spellOut?: string[]; // acronyms to read letter-by-letter (API → A-P-I)
  backend: Backend;
  command: string; // explicit CLI for backend "cli"
  model: string; // for backend "api"
  apiKey?: string; // for backend "api" (from SecretStorage)
  timeoutMs: number;
}

// ---- cache -----------------------------------------------------------------

const CACHE = new Map<string, string>();
const CACHE_CAP = 500;

function cacheKey(o: NormalizeOptions, text: string): string {
  return [o.mode, o.backend, o.command, o.model, o.rules, text].join("\u0000");
}
function cacheGet(k: string): string | undefined {
  return CACHE.get(k);
}
function cacheSet(k: string, v: string) {
  if (CACHE.size >= CACHE_CAP) CACHE.delete(CACHE.keys().next().value as string);
  CACHE.set(k, v);
}

// ---- backends --------------------------------------------------------------

/**
 * Resolve a CLI to an absolute path. The extension host's PATH often omits
 * user install dirs (e.g. ~/.local/bin), so we probe the login PATH and common
 * locations rather than relying on bare-name spawn. Returns null if not found.
 */
function resolveCli(name: string): string | null {
  if (name.includes("/") || (IS_WIN && name.includes("\\"))) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  // Common install locations (covers npm-global, homebrew, local bins). On
  // Windows only .exe and .cmd shims are runnable — npm also writes an
  // extensionless sh script next to the .cmd, which spawn can't execute.
  const home = homedir();
  const candidates = IS_WIN
    ? [
        join(home, ".local", "bin"), // Claude Code native installer
        join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
        join(home, ".bun", "bin"),
        join(home, ".claude", "local"),
      ].flatMap((dir) => [join(dir, `${name}.exe`), join(dir, `${name}.cmd`)])
    : [
        join(home, ".local", "bin", name),
        `/usr/local/bin/${name}`,
        `/opt/homebrew/bin/${name}`,
        join(home, ".bun", "bin", name),
        join(home, ".npm-global", "bin", name),
        join(home, ".claude", "local", name),
      ];
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  // Fall back to the login PATH via a shell. Pass the name as a positional arg
  // ($1) with a fixed script — never interpolate it into the shell string, or a
  // malicious `command` setting could inject shell commands.
  try {
    const probe = IS_WIN
      ? spawnSync("where", [name], { encoding: "utf8" })
      : spawnSync("/bin/sh", ["-lc", 'command -v "$1"', "sh", name], {
          encoding: "utf8",
        });
    const lines = (probe.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // `where` lists every PATH match, extensionless shims first; take the first
    // .exe, else the first .cmd/.bat.
    const line = IS_WIN
      ? lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l))
      : lines[0];
    if (probe.status === 0 && line) return line;
  } catch {
    /* ignore */
  }
  return null;
}

/** CLI name without directory or Windows extension, e.g. "codex". */
function cliName(cmd: string): string {
  return basename(cmd).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * spawn() that also runs Windows .cmd/.bat shims (how npm installs claude and
 * codex). Node refuses to spawn those without a shell (CVE-2024-27980), so run
 * them through cmd.exe with every argument quoted by us. Arguments here are
 * fixed flags and a temp path — the prompt itself goes over stdin.
 */
function spawnCli(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (IS_WIN && /\.(cmd|bat)$/i.test(cmd)) {
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return spawn([cmd, ...args].map(quote).join(" "), {
      ...opts,
      shell: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(cmd, args, opts);
}

/** Kill a CLI and its children. On Windows a .cmd shim runs under cmd.exe, and
 *  killing that leaves the real (node) process running, so kill the tree. */
function killTree(proc: ChildProcess) {
  try {
    if (IS_WIN && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  }
}

/** Resolve which concrete backend to use, or null if none is available. */
function resolveBackend(
  o: BackendOptions
): { kind: "cli"; cmd: string } | { kind: "api" } | null {
  if (o.backend === "api") return o.apiKey ? { kind: "api" } : null;
  if (o.backend === "cli") {
    const cmd = o.command
      ? resolveCli(o.command)
      : resolveCli("claude") ?? resolveCli("codex");
    return cmd ? { kind: "cli", cmd } : null;
  }
  // auto
  const cmd = resolveCli("claude") ?? resolveCli("codex");
  if (cmd) return { kind: "cli", cmd };
  if (o.apiKey) return { kind: "api" };
  return null;
}

function runCli(
  cmd: string,
  prompt: string,
  timeoutMs: number
): Promise<string | null> {
  // Isolate from the workspace: run in an empty temp dir, no tools/file access.
  const dir = mkdtempSync(join(tmpdir(), "kokoro-norm-"));

  return new Promise((resolve) => {
    let proc: ChildProcess;
    let outFile: string | undefined;
    if (cliName(cmd) === "codex") {
      outFile = join(dir, "out.txt");
      proc = spawnCli(
        cmd,
        [
          "exec",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--color",
          "never",
          "-C",
          dir,
          "-o",
          outFile,
        ],
        { stdio: ["pipe", "ignore", "ignore"], cwd: dir }
      );
    } else {
      // claude (and claude-compatible): print mode, JSON output, no tools.
      proc = spawnCli(cmd, ["-p", "--output-format", "json", "--allowed-tools", ""], {
        stdio: ["pipe", "pipe", "ignore"],
        cwd: dir,
      });
    }

    let stdout = "";
    if (proc.stdout) proc.stdout.on("data", (d) => (stdout += d));

    const timer = setTimeout(() => {
      killTree(proc);
      cleanup();
      resolve(null);
    }, timeoutMs);

    const cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    proc.on("error", () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      let result: string | null = null;
      try {
        if (outFile) {
          result = readFileSync(outFile, "utf8").trim();
        } else if (code === 0 && stdout) {
          const parsed = JSON.parse(stdout);
          result = (parsed.result ?? parsed.text ?? "").trim();
        }
      } catch {
        result = null;
      }
      cleanup();
      resolve(result ? stripWrapping(result) : null);
    });

    try {
      proc.stdin?.end(prompt);
    } catch {
      /* ignore */
    }
  });
}

export interface BackendOptions {
  backend: Backend;
  command: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

/** True if an AI backend (CLI or API key) is available for `opts`. */
export function hasBackend(opts: BackendOptions): boolean {
  return resolveBackend(opts) !== null;
}

/**
 * Run one LLM turn through the configured backend (CLI or API). Returns the raw
 * text response, or null if no backend is available or the call fails. Shared by
 * normalization and the AI configuration flow.
 */
export async function callBackend(
  system: string,
  user: string,
  opts: BackendOptions,
  maxTokens = 4096
): Promise<string | null> {
  const backend = resolveBackend(opts);
  if (backend?.kind === "cli") {
    return runCli(backend.cmd, `${system}\n\n${user}`, opts.timeoutMs);
  }
  if (backend?.kind === "api") {
    return anthropicCall({ apiKey: opts.apiKey!, model: opts.model, timeoutMs: opts.timeoutMs })(system, user, maxTokens);
  }
  return null;
}

// ---- entry point -----------------------------------------------------------

/** Rewrite `text` into speech-friendly form per `opts`. Never throws. */
export async function normalize(
  text: string,
  opts: NormalizeOptions
): Promise<string> {
  if (opts.mode === "off" || !text.trim()) return text;

  // User replacements + acronym spell-out apply first (and feed the LLM a
  // guaranteed pass in ai mode).
  const pre = preNormalize(text, opts);

  if (opts.mode === "deterministic") return deterministic(pre);

  // mode === "ai"
  const key = cacheKey(opts, pre);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const final = await aiNormalize(pre, opts.rules, (system, user, maxTokens) =>
    callBackend(system, user, opts, maxTokens)
  );
  cacheSet(key, final);
  return final;
}
