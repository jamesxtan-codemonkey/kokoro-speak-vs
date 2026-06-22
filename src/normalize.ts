// Text normalization: rewrite text into a speech-friendly form before synthesis.
// Runs in the extension host. Three modes (kokoroSpeak.normalization.mode):
//   off           — no normalization
//   deterministic — built-in regex rules + user replacements (offline, instant)
//   ai            — an LLM applies the natural-language rules; deterministic is
//                   the fallback when the backend is unavailable or fails.
// No `vscode` import — pure logic, unit-testable in Node.

import { spawn, spawnSync } from "child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

export type NormMode = "off" | "deterministic" | "ai";
export type Backend = "auto" | "cli" | "api";
// Normalization profile, chosen from the file type. "prose" = the original
// behavior (currency/percent/dates…). "code" = expand operators, skip prose-only
// rules that misfire on source ($, %). Identifier splitting applies to both.
export type Profile = "prose" | "code";

export interface Replacement {
  from?: string; // literal match
  pattern?: string; // OR a regex source
  to?: string;
  replacement?: string;
  flags?: string;
}

export interface NormalizeOptions {
  mode: NormMode;
  rules: string;
  replacements: Replacement[];
  spellOut?: string[]; // acronyms to read letter-by-letter (API → A P I)
  backend: Backend;
  command: string; // explicit CLI for backend "cli"
  model: string; // for backend "api"
  apiKey?: string; // for backend "api" (from SecretStorage)
  timeoutMs: number;
  profile?: Profile; // deterministic engine variant (default "prose")
  languageId?: string; // source file type, for the AI-mode context hint
}

// ---- deterministic engine --------------------------------------------------

const SCALE: Record<string, string> = {
  k: "thousand",
  m: "million",
  b: "billion",
  t: "trillion",
};

// Curated emoji → short spoken word. Anything not listed is dropped (silent)
// rather than read as raw Unicode. Meaningful symbols speak; decorative ones
// (most faces) are removed.
const EMOJI: Record<string, string> = {
  "✅": "check", "✔": "check", "✓": "check", "☑": "check", "🆗": "okay",
  "❌": "cross", "✖": "cross", "✗": "cross", "⛔": "no entry", "🚫": "no",
  "⚠": "warning", "‼": "warning", "❗": "warning", "❓": "question",
  "ℹ": "info", "💡": "light bulb", "📝": "note", "📌": "pin", "🔗": "link",
  "🚀": "rocket", "🔥": "fire", "✨": "sparkles", "⭐": "star", "🌟": "star",
  "🎉": "party", "🎊": "party", "🎯": "target", "🐛": "bug", "💯": "one hundred",
  "👍": "thumbs up", "👎": "thumbs down", "🙏": "thanks", "👀": "eyes",
  "🤔": "thinking", "🛑": "stop", "⏰": "alarm", "📅": "calendar",
  "🔒": "locked", "🔓": "unlocked", "⏳": "hourglass", "💀": "skull",
  "❤": "heart", "🧡": "heart", "💛": "heart", "💚": "heart", "💙": "heart",
  "💜": "heart", "🖤": "heart", "🤍": "heart", "🤎": "heart",
};

const ABBREV: Array<[RegExp, string]> = [
  [/\be\.g\.(?=\s|$|,)/gi, "for example"],
  [/\bi\.e\.(?=\s|$|,)/gi, "that is"],
  [/\betc\.(?=\s|$|,)/gi, "etcetera"],
  [/\bvs\.?(?=\s|$|,)/gi, "versus"],
  [/\bapprox\.(?=\s|$|,)/gi, "approximately"],
  [/\bDr\.(?=\s)/g, "Doctor"],
  [/\bMr\.(?=\s)/g, "Mister"],
  [/\bMrs\.(?=\s)/g, "Missus"],
  [/\bMs\.(?=\s)/g, "Miz"],
  [/\bProf\.(?=\s)/g, "Professor"],
];

const ORDINAL = ["", "first", "second", "third", "fourth"];

/** Apply user-defined literal/regex replacements. */
export function applyReplacements(text: string, reps: Replacement[]): string {
  let out = text;
  for (const r of reps ?? []) {
    try {
      if (r.pattern != null) {
        out = out.replace(new RegExp(r.pattern, r.flags ?? "g"), r.replacement ?? "");
      } else if (r.from) {
        out = out.split(r.from).join(r.to ?? "");
      }
    } catch {
      /* skip a malformed rule rather than fail the whole pass */
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Spell listed acronyms letter-by-letter: "API" → "A P I" (whole words only). */
export function applySpellOut(text: string, list?: string[]): string {
  let out = text;
  for (const a of list ?? []) {
    const acr = a?.trim();
    if (!acr) continue;
    out = out.replace(
      new RegExp(`\\b${escapeRegExp(acr)}\\b`, "g"),
      acr.split("").join(" ")
    );
  }
  return out;
}

/**
 * Built-in transforms. Principle: expand symbols / scales / abbreviations to
 * words, but leave bare digit runs for Kokoro to vocalize ("10 billion dollars"
 * is read correctly as-is). Conservative — ambiguous cases are left alone and
 * handled by the `ai` mode instead.
 */
/**
 * Silence Markdown emphasis markers so they aren't read as "asterisk". Strips
 * PAIRED emphasis only — **bold**, *italic*, __x__, _x_ vanish (the word
 * stays) — while lone operators (2*3, *ptr, **kwargs) and identifiers
 * (snake_case) survive. Applied in the normalizer (not just the Markdown
 * stripper) so emphasis in text spoken from a non-Markdown editor, or returned
 * by the LLM, is still silenced. The inner-no-space guard on `*` keeps spaced
 * multiplication ("a * b") intact; `_` only at word boundaries (CommonMark).
 */
export function stripEmphasis(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(?!\s)([^*]+?)(?<!\s)\*/g, "$1")
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1");
}

// Mixed-case names that are real words, not identifiers to split apart. Compared
// lowercased. (All-caps acronyms like JSON/HTML have no case boundary and are
// never split anyway, so they don't need listing here.)
const KEEP_WHOLE = new Set([
  "javascript", "typescript", "github", "gitlab", "bitbucket", "paypal",
  "youtube", "iphone", "ipad", "ipod", "imac", "macos", "ios", "ipados",
  "oauth", "openai", "openssl", "graphql", "postgresql", "mongodb", "dynamodb",
  "nodejs", "leetcode", "stackoverflow", "devops", "wifi", "latex",
]);

/** Split one identifier into spoken words at camelCase / snake_case boundaries. */
function splitCamel(w: string): string {
  if (!w || KEEP_WHOLE.has(w.toLowerCase())) return w;
  return w
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // fooBar → foo Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // XMLHttp → XML Http
}

/**
 * Read code identifiers as words: split camelCase / PascalCase / snake_case /
 * SCREAMING_SNAKE into space-separated words (getUserName → "get User Name";
 * MAX_BUFFER → "MAX BUFFER"). Applies to ALL text (prose too) — names like
 * `useEffect` read correctly wherever they appear. Only tokens with an internal
 * case/underscore boundary are touched, and a small allowlist (JavaScript,
 * GitHub…) is preserved whole.
 */
export function splitIdentifiers(text: string): string {
  return text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
    // Fast path: leave plain words / all-caps acronyms / numbers untouched —
    // only tokens with an internal underscore or case boundary are split.
    if (!/_|[a-z0-9][A-Z]|[A-Z]{2,}[a-z]/.test(m)) return m;
    if (KEEP_WHOLE.has(m.toLowerCase())) return m;
    return m
      .replace(/_+/g, " ") // snake_case → spaces
      .trim()
      .split(/\s+/)
      .map(splitCamel)
      .join(" ");
  });
}

// Multi-char operators → words, for the "code" profile. Longest/most specific
// first (=== before ==, !== before !=) so a prefix doesn't match early.
const OPERATORS: Array<[RegExp, string]> = [
  [/===/g, " strictly equals "],
  [/!==/g, " strictly not equal "],
  [/==/g, " equals "],
  [/!=/g, " not equal "],
  [/<=/g, " less than or equal "],
  [/>=/g, " greater than or equal "],
  [/&&/g, " and "],
  [/\|\|/g, " or "],
  [/\+\+/g, " plus plus "],
  [/--/g, " minus minus "],
  [/\+=/g, " plus equals "],
  [/-=/g, " minus equals "],
  [/\*=/g, " times equals "],
  [/\/=/g, " over equals "],
  [/=>/g, " arrow "],
  [/::/g, " scope "],
  [/(?<=[A-Za-z0-9_)\]])->(?=[A-Za-z_])/g, " arrow "], // member access x->y
];

/** Expand common multi-char source operators to words (code profile only). */
export function expandOperators(text: string): string {
  let s = text;
  for (const [re, repl] of OPERATORS) s = s.replace(re, repl);
  return s;
}

export function deterministic(text: string, profile: Profile = "prose"): string {
  let s = stripEmphasis(text);
  s = splitIdentifiers(s); // both profiles
  if (profile === "code") s = expandOperators(s);

  // Arrows → "to". Unicode arrows in any context; the ASCII single "->" only
  // when whitespace-flanked, so code like "x->y", "a->b" is left intact. A
  // double "-->" is deliberately not matched — it's ambiguous with HTML comment
  // closes ("<!-- -->") and code, so leave it alone. Non-consuming boundaries
  // let adjacent arrows ("-> ->") both convert.
  s = s.replace(/\s*(?:→|⟶|⇒|↦)\s*/g, " to ");
  s = s.replace(/(?<=^|\s)->(?=\s|$)/g, "to");

  // Prose-only number/symbol rules. Skipped for the "code" profile, where `$`,
  // `%`, and `k/m/b` scale suffixes mean variables, modulo, and hex/identifiers —
  // not currency, percent, or magnitudes.
  if (profile === "prose") {
    // Tilde before a number/currency → "about" (~100 → about 100).
    s = s.replace(/~\s?(?=[\d$])/g, "about ");

    // Numeric dates (ISO YYYY-MM-DD) → read each group separately, NOT as a
    // range. We can't reliably tell the month from the day across locale formats,
    // so we don't interpret — just swap the hyphens for pauses so "2026-06-16" is
    // spoken as "2026, 06, 16" rather than the wrong "2026 to 06 to 16". Runs
    // before the range rules so a 4-2-2 date is never mistaken for a range.
    s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$1, $2, $3");

    // Ranges (en/em dash between number-ish tokens) → " to ".
    s = s.replace(/(\d[\d,]*(?:\.\d+)?\s?[kKmMbBtT]?)\s?[–—]\s?(?=\d)/g, "$1 to ");
    // ASCII hyphen ranges only in the unambiguous percent context ("5-20%" →
    // "5 to 20 percent"); bare "a-b" hyphens are left alone (dates, phone
    // numbers, negatives) and handled by ai mode instead.
    s = s.replace(
      /(\d[\d,]*(?:\.\d+)?)\s?-\s?(\d[\d,]*(?:\.\d+)?)(?=\s?%)/g,
      "$1 to $2"
    );

    // Currency with scale: $10B → 10 billion dollars
    s = s.replace(
      /\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmMbBtT])\b/g,
      (_m, num, sc) => `${num} ${SCALE[sc.toLowerCase()]} dollars`
    );
    // Plain currency: $10 → 10 dollars
    s = s.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars");

    // Percentages: 50% → 50 percent (a leading ~ was handled above).
    s = s.replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, "$1 percent");

    // Standalone scale after a number: 345k → 345 thousand
    s = s.replace(
      /\b(\d[\d,]*(?:\.\d+)?)\s?([kKmMbBtT])\b/g,
      (_m, num, sc) => `${num} ${SCALE[sc.toLowerCase()]}`
    );

    // Versions: v1.2.3 → version 1 point 2 point 3
    s = s.replace(/\bv(\d+(?:\.\d+)+)\b/gi, (_m, ver: string) => {
      return "version " + ver.split(".").join(" point ");
    });

    // Quarters: Q4 2025 → fourth quarter 2025; Q4 → fourth quarter
    s = s.replace(/\bQ([1-4])\b(\s+\d{4})?/g, (_m, q: string, year: string) => {
      return `${ORDINAL[Number(q)]} quarter${year ?? ""}`;
    });

    // "&" → "and" (in code it's bitwise-and / address-of — leave it).
    s = s.replace(/\s?&\s?/g, " and ");
  }

  // Abbreviations.
  for (const [re, repl] of ABBREV) s = s.replace(re, repl);

  // "@" → "at" (emails, handles, decorators) in both profiles.
  s = s.replace(/@/g, " at ");

  // Emoji → short words (known) then drop the rest, so nothing is read as raw
  // Unicode. Known glyphs first (covers dingbats not flagged as emoji), then
  // strip joiners/variation-selectors/skin tones and any remaining pictographs.
  for (const [e, w] of Object.entries(EMOJI)) {
    if (s.includes(e)) s = s.split(e).join(` ${w} `);
  }
  s = s.replace(/[\u200D\uFE0F]|\p{Emoji_Modifier}/gu, "");
  s = s.replace(/\p{Extended_Pictographic}/gu, " ");

  // Drop thousands commas inside numbers so the TTS reads them cleanly.
  s = s.replace(/(?<=\d),(?=\d{3}\b)/g, "");

  // Tidy whitespace introduced by replacements.
  return s.replace(/[ \t]{2,}/g, " ").trim();
}

/** Cheap pre-check: is there anything worth normalizing? */
export function hasCandidates(text: string): boolean {
  return /[$%@&]|\d|\b(?:e\.g\.|i\.e\.|etc\.|vs\.|approx\.|Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.)|\bv\d+\.\d|\bQ[1-4]\b/i.test(
    text
  );
}

// ---- LLM prompt ------------------------------------------------------------

const INSTRUCTION =
  "You rewrite text so it sounds correct when read aloud by a text-to-speech engine. " +
  "Apply the rules below. Output ONLY the rewritten text — no preamble, no quotes, " +
  "no markdown, no explanation. Preserve meaning and wording except where a rule " +
  "applies. If nothing needs changing, return the text unchanged.";

function buildSystem(rules: string): string {
  return `${INSTRUCTION}\n\nRules:\n${rules.trim()}`;
}

// ---- cache -----------------------------------------------------------------

const CACHE = new Map<string, string>();
const CACHE_CAP = 500;

function cacheKey(o: NormalizeOptions, text: string): string {
  return [o.mode, o.backend, o.command, o.model, o.profile ?? "prose", o.languageId ?? "", o.rules, text].join("\u0000");
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
  if (name.includes("/")) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  // Common install locations (covers npm-global, homebrew, local bins).
  if (process.platform !== "win32") {
    const home = homedir();
    for (const c of [
      join(home, ".local", "bin", name),
      `/usr/local/bin/${name}`,
      `/opt/homebrew/bin/${name}`,
      join(home, ".bun", "bin", name),
      join(home, ".npm-global", "bin", name),
      join(home, ".claude", "local", name),
    ]) {
      try {
        accessSync(c, constants.X_OK);
        return c;
      } catch {
        /* keep looking */
      }
    }
  }
  // Fall back to the login PATH via a shell. Pass the name as a positional arg
  // ($1) with a fixed script — never interpolate it into the shell string, or a
  // malicious `command` setting could inject shell commands.
  try {
    const probe =
      process.platform === "win32"
        ? spawnSync("where", [name], { encoding: "utf8" })
        : spawnSync("/bin/sh", ["-lc", 'command -v "$1"', "sh", name], {
            encoding: "utf8",
          });
    const line = (probe.stdout || "").split("\n")[0].trim();
    if (probe.status === 0 && line) return line;
  } catch {
    /* ignore */
  }
  return null;
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
    let proc;
    let outFile: string | undefined;
    if (cmd === "codex" || cmd.endsWith("/codex")) {
      outFile = join(dir, "out.txt");
      proc = spawn(
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
      proc = spawn(cmd, ["-p", "--output-format", "json", "--allowed-tools", ""], {
        stdio: ["pipe", "pipe", "ignore"],
        cwd: dir,
      });
    }

    let stdout = "";
    if (proc.stdout) proc.stdout.on("data", (d) => (stdout += d));

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
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

async function runApi(
  system: string,
  user: string,
  model: string,
  apiKey: string,
  timeoutMs: number,
  maxTokens: number
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    // Only a clean completion is usable; refusal or a max_tokens cut would
    // return text truncated mid-sentence — fall back to deterministic instead.
    if (data?.stop_reason && data.stop_reason !== "end_turn") return null;
    const out = (data?.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    return out ? stripWrapping(out) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    return runApi(system, user, opts.model, opts.apiKey!, opts.timeoutMs, maxTokens);
  }
  return null;
}

/** Strip accidental code-fence / quote wrapping from a model response. */
function stripWrapping(s: string): string {
  let t = s.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') t = t.slice(1, -1);
  return t.trim();
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
  const pre = applySpellOut(
    applyReplacements(text, opts.replacements),
    opts.spellOut
  );

  if (opts.mode === "deterministic") return deterministic(pre, opts.profile);

  // mode === "ai"
  const key = cacheKey(opts, pre);
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  if (!hasCandidates(pre)) {
    const det = deterministic(pre, opts.profile);
    cacheSet(key, det);
    return det;
  }

  // Tell the LLM what kind of file this is, so it normalizes in context (read a
  // `.c` file's code/identifiers/operators the way a programmer would say them).
  const hint =
    opts.profile === "code"
      ? `The text below is source code${
          opts.languageId ? ` (${opts.languageId})` : ""
        }. Read comments and strings as prose; read code, identifiers, and operators the way a developer would say them aloud.\n\n`
      : "";

  const result = await callBackend(
    buildSystem(opts.rules),
    `${hint}Text to rewrite:\n${pre}`,
    opts,
    // Char count as a token proxy: generous for English, safe for multibyte
    // text where chars≈tokens, so output isn't capped mid-sentence.
    Math.min(8192, pre.length + 256)
  );

  // Strip emphasis from the model's output too — a guaranteed floor so markers
  // are never spoken even if the model echoes them. Fall back to deterministic
  // on any failure.
  const final = result ? stripEmphasis(result) : deterministic(pre, opts.profile);
  cacheSet(key, final);
  return final;
}

export const SEED_RULES = `- Currency: "$10B" → "10 billion dollars"; "$3.5M" → "3.5 million dollars".
- Tilde before a number means about: "~100 events" → "about 100 events"; "~5-20%" → "about 5 to 20 percent".
- Ranges: "5-20%" → "5 to 20 percent"; "2010-2020" → "2010 to 2020".
- Dates: read a numeric date like "2026-06-16" as separate groups with pauses ("2026, 06, 16") — never as a range, never say "to". Don't guess which field is the month versus the day.
- Percentages: "50%" → "50 percent".
- Arrows mean "to": "A → C" → "A to C"; "step 1 -> step 2" → "step 1 to step 2".
- Versions: "v1.2.3" → "version 1 point 2 point 3".
- Quarters: "Q4 2025" → "fourth quarter 2025".
- Abbreviations: "e.g." → "for example"; "i.e." → "that is"; "etc." → "etcetera".
- Spell out initialism acronyms letter by letter (API → "A P I"; LFP → "L F P"), but keep pronounceable acronyms/names as words (NASA, OSCAR, JSON).
- Never read Markdown markers aloud: "**" and "*" emphasis are silent (keep the word).
- Read check marks as "check": "✅" → "check". Read other emoji as a short word for what they mean, or drop them.
- Read code identifiers naturally (split camelCase / snake_case into words).
- Expand units and symbols, but leave ordinary numbers for the speech engine.
- Do not change meaning; only rewrite how things are spoken.`;
