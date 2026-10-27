// Text normalization shared by the VS Code and Chrome extensions: rewrite text
// into a speech-friendly form before synthesis. Pure apart from the Anthropic
// API call, which works in Node and in the browser.
//
// Every rule is a regex rewrite (a Pass), so the same rules run two ways:
// on a plain string (`deterministic`), or on a MappedText, which remembers
// which input characters each output character came from. The Chrome
// extension needs that to highlight the words on the page being spoken after
// "$10B" has become "10 billion dollars".

import Anthropic from "@anthropic-ai/sdk";

export type NormMode = "off" | "deterministic" | "ai";

export interface Replacement {
  from?: string; // literal match
  pattern?: string; // OR a regex source
  to?: string;
  replacement?: string;
  flags?: string;
}

// ---- passes and mapped text -------------------------------------------------

type Replacer = string | ((match: string, ...rest: any[]) => string);
type Pass = [RegExp, Replacer];

/** String.replace's `$` substitutions ($$, $&, $`, $', $n, $nn, $<name>). */
function substitute(template: string, args: any[]): string {
  const hasGroups = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
  const groups = hasGroups ? args[args.length - 1] : undefined;
  const str: string = args[args.length - (hasGroups ? 2 : 1)];
  const offset: number = args[args.length - (hasGroups ? 3 : 2)];
  const match: string = args[0];
  const caps: (string | undefined)[] = args.slice(1, args.length - (hasGroups ? 3 : 2));
  return template.replace(/\$([$&`']|\d{1,2}|<[^>]*>)/g, (tok, k: string) => {
    if (k === "$") return "$";
    if (k === "&") return match;
    if (k === "`") return str.slice(0, offset);
    if (k === "'") return str.slice(offset + match.length);
    if (k[0] === "<") return groups ? groups[k.slice(1, -1)] ?? "" : tok;
    // $nn when that group exists, else $n followed by a digit (spec behavior).
    if (k.length === 2 && Number(k) >= 1 && Number(k) <= caps.length) return caps[Number(k) - 1] ?? "";
    const n = Number(k[0]);
    if (n >= 1 && n <= caps.length) return (caps[n - 1] ?? "") + k.slice(1);
    return tok;
  });
}

/**
 * Text plus, per character, the input range it came from: unchanged
 * characters map to themselves, rewritten ones to the whole match they replaced.
 */
export class MappedText {
  private constructor(
    readonly text: string,
    private readonly starts: Int32Array,
    private readonly ends: Int32Array
  ) {}

  static of(text: string): MappedText {
    const starts = new Int32Array(text.length);
    const ends = new Int32Array(text.length);
    for (let i = 0; i < text.length; i++) {
      starts[i] = i;
      ends[i] = i + 1;
    }
    return new MappedText(text, starts, ends);
  }

  /** The input range behind text[start, end). */
  source(start: number, end: number): [number, number] {
    if (!this.text.length) return [0, 0];
    const s = Math.min(start, this.text.length - 1);
    const e = Math.max(Math.min(end, this.text.length) - 1, s);
    return [this.starts[s], this.ends[e]];
  }

  replace(re: RegExp, to: Replacer): MappedText {
    const edits: Array<[number, number, string]> = []; // offset, match length, replacement
    const text = this.text.replace(re, (...args: any[]) => {
      const hasGroups = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
      const offset: number = args[args.length - (hasGroups ? 3 : 2)];
      const out = typeof to === "function" ? to(...(args as [string, ...any[]])) : substitute(to, args);
      edits.push([offset, args[0].length, out]);
      return out;
    });
    if (!edits.length) return this;
    const starts = new Int32Array(text.length);
    const ends = new Int32Array(text.length);
    let i = 0; // input position
    let o = 0; // output position
    for (const [offset, len, out] of edits) {
      for (; i < offset; i++, o++) {
        starts[o] = this.starts[i];
        ends[o] = this.ends[i];
      }
      // A zero-length match maps its insertion to the character it precedes.
      const [s, e] = len
        ? [this.starts[offset], this.ends[offset + len - 1]]
        : this.source(offset, offset + 1);
      for (let k = 0; k < out.length; k++, o++) {
        starts[o] = s;
        ends[o] = e;
      }
      i = offset + len;
    }
    for (; i < this.text.length; i++, o++) {
      starts[o] = this.starts[i];
      ends[o] = this.ends[i];
    }
    return new MappedText(text, starts, ends);
  }

  trim(): MappedText {
    const a = this.text.length - this.text.trimStart().length;
    const b = this.text.trimEnd().length;
    if (a === 0 && b === this.text.length) return this;
    return new MappedText(this.text.slice(a, Math.max(a, b)), this.starts.slice(a, Math.max(a, b)), this.ends.slice(a, Math.max(a, b)));
  }
}

function runPasses(text: string, passes: Pass[]): string {
  let s = text;
  for (const [re, to] of passes) s = s.replace(re, to as any);
  return s;
}

function runMapped(mt: MappedText, passes: Pass[]): MappedText {
  for (const [re, to] of passes) mt = mt.replace(re, to);
  return mt;
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

const ABBREV: Pass[] = [
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A literal find-and-replace (no `$` substitutions in `to`). */
const literal = (from: string, to: string): Pass => [new RegExp(escapeRegExp(from), "g"), () => to];

function replacementPasses(reps: Replacement[] | undefined): Pass[] {
  const passes: Pass[] = [];
  for (const r of reps ?? []) {
    try {
      if (r.pattern != null) passes.push([new RegExp(r.pattern, r.flags ?? "g"), r.replacement ?? ""]);
      else if (r.from) passes.push(literal(r.from, r.to ?? ""));
    } catch {
      /* skip a malformed rule rather than fail the whole pass */
    }
  }
  return passes;
}

function spellOutPasses(list: string[] | undefined): Pass[] {
  return (list ?? [])
    .map((a) => a?.trim())
    .filter(Boolean)
    .map((acr) => [new RegExp(`\\b${escapeRegExp(acr)}\\b`, "g"), acr.split("").join(" ")]);
}

/** Apply user-defined literal/regex replacements. */
export function applyReplacements(text: string, reps: Replacement[]): string {
  return runPasses(text, replacementPasses(reps));
}

/** Spell listed acronyms letter-by-letter: "API" → "A P I" (whole words only). */
export function applySpellOut(text: string, list?: string[]): string {
  return runPasses(text, spellOutPasses(list));
}

/**
 * Silence Markdown emphasis markers so they aren't read as "asterisk". Strips
 * PAIRED emphasis only — **bold**, *italic*, __x__, _x_ vanish (the word
 * stays) — while lone operators (2*3, *ptr, **kwargs) and identifiers
 * (snake_case) survive. Applied in the normalizer (not just the Markdown
 * stripper) so emphasis in text spoken from a non-Markdown editor, or returned
 * by the LLM, is still silenced. The inner-no-space guard on `*` keeps spaced
 * multiplication ("a * b") intact; `_` only at word boundaries (CommonMark).
 */
const EMPHASIS: Pass[] = [
  [/\*\*(.+?)\*\*/g, "$1"],
  [/\*(?!\s)([^*]+?)(?<!\s)\*/g, "$1"],
  [/(?<!\w)__(.+?)__(?!\w)/g, "$1"],
  [/(?<!\w)_(.+?)_(?!\w)/g, "$1"],
];

export function stripEmphasis(s: string): string {
  return runPasses(s, EMPHASIS);
}

/**
 * Built-in transforms. Principle: expand symbols / scales / abbreviations to
 * words, but leave bare digit runs for Kokoro to vocalize ("10 billion dollars"
 * is read correctly as-is). Conservative — ambiguous cases are left alone and
 * handled by the `ai` mode instead.
 */
const DETERMINISTIC: Pass[] = [
  ...EMPHASIS,

  // Arrows → "to". Unicode arrows in any context; the ASCII single "->" only
  // when whitespace-flanked, so code like "x->y", "a->b" is left intact. A
  // double "-->" is deliberately not matched — it's ambiguous with HTML comment
  // closes ("<!-- -->") and code, so leave it alone. Non-consuming boundaries
  // let adjacent arrows ("-> ->") both convert.
  [/\s*(?:→|⟶|⇒|↦)\s*/g, " to "],
  [/(?<=^|\s)->(?=\s|$)/g, "to"],

  // Tilde before a number/currency → "about" (~100 → about 100).
  [/~\s?(?=[\d$])/g, "about "],

  // Numeric dates (ISO YYYY-MM-DD) → read each group separately, NOT as a range.
  // We can't reliably tell the month from the day across locale formats, so we
  // don't interpret — just swap the hyphens for pauses so "2026-06-16" is spoken
  // as "2026, 06, 16" rather than the wrong "2026 to 06 to 16". Runs before the
  // range rules so a 4-2-2 date is never mistaken for a numeric range.
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$1, $2, $3"],

  // Ranges (en/em dash between number-ish tokens) → " to ".
  [/(\d[\d,]*(?:\.\d+)?\s?[kKmMbBtT]?)\s?[–—]\s?(?=\d)/g, "$1 to "],
  // ASCII hyphen ranges only in the unambiguous percent context ("5-20%" →
  // "5 to 20 percent"); bare "a-b" hyphens are left alone (dates, phone numbers,
  // negatives) and handled by ai mode instead.
  [/(\d[\d,]*(?:\.\d+)?)\s?-\s?(\d[\d,]*(?:\.\d+)?)(?=\s?%)/g, "$1 to $2"],

  // Currency with scale: $10B → 10 billion dollars
  [/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmMbBtT])\b/g, (_m, num, sc) => `${num} ${SCALE[sc.toLowerCase()]} dollars`],
  // Plain currency: $10 → 10 dollars
  [/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars"],

  // Percentages: 50% → 50 percent (a leading ~ was handled above).
  [/(\d[\d,]*(?:\.\d+)?)\s?%/g, "$1 percent"],

  // Standalone scale after a number: 345k → 345 thousand
  [/\b(\d[\d,]*(?:\.\d+)?)\s?([kKmMbBtT])\b/g, (_m, num, sc) => `${num} ${SCALE[sc.toLowerCase()]}`],

  // Versions: v1.2.3 → version 1 point 2 point 3
  [/\bv(\d+(?:\.\d+)+)\b/gi, (_m, ver: string) => "version " + ver.split(".").join(" point ")],

  // Quarters: Q4 2025 → fourth quarter 2025; Q4 → fourth quarter
  [/\bQ([1-4])\b(\s+\d{4})?/g, (_m, q: string, year: string) => `${ORDINAL[Number(q)]} quarter${year ?? ""}`],

  ...ABBREV,

  // Symbols.
  [/\s?&\s?/g, " and "],
  [/@/g, " at "],

  // Emoji → short words (known) then drop the rest, so nothing is read as raw
  // Unicode. Known glyphs first (covers dingbats not flagged as emoji), then
  // strip joiners/variation-selectors/skin tones and any remaining pictographs.
  ...Object.entries(EMOJI).map(([e, w]) => literal(e, ` ${w} `)),
  [/[‍️]|\p{Emoji_Modifier}/gu, ""],
  [/\p{Extended_Pictographic}/gu, " "],

  // Drop thousands commas inside numbers so the TTS reads them cleanly.
  [/(?<=\d),(?=\d{3}\b)/g, ""],

  // Tidy whitespace introduced by replacements.
  [/[ \t]{2,}/g, " "],
];

export function deterministic(text: string): string {
  return runPasses(text, DETERMINISTIC).trim();
}

/** Cheap pre-check: is there anything worth normalizing? */
export function hasCandidates(text: string): boolean {
  return /[$%@&]|\d|\b(?:e\.g\.|i\.e\.|etc\.|vs\.|approx\.|Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.)|\bv\d+\.\d|\bQ[1-4]\b/i.test(
    text
  );
}

export interface LocalRules {
  replacements?: Replacement[];
  spellOut?: string[];
}

/** User replacements + acronym spell-out: applied first in every mode except
 *  off (and fed to the LLM in ai mode, as a guaranteed pass). */
export function preNormalize(text: string, o: LocalRules): string {
  return applySpellOut(applyReplacements(text, o.replacements ?? []), o.spellOut);
}

/**
 * The offline normalization of `text` with its map back to `text`: the user's
 * rules, then (unless mode is off) the built-in ones. Chrome chunks this so
 * sentence breaks fall where they do when spoken ("e.g. this" is one sentence
 * once it reads "for example this").
 */
export function normalizeMapped(text: string, mode: NormMode, o: LocalRules): MappedText {
  const mt = MappedText.of(text);
  if (mode === "off") return mt;
  return runMapped(mt, [...replacementPasses(o.replacements), ...spellOutPasses(o.spellOut), ...DETERMINISTIC]).trim();
}

// ---- LLM rewriting ---------------------------------------------------------

const INSTRUCTION =
  "You rewrite text so it sounds correct when read aloud by a text-to-speech engine. " +
  "Apply the rules below. Output ONLY the rewritten text — no preamble, no quotes, " +
  "no markdown, no explanation. Preserve meaning and wording except where a rule " +
  "applies. If nothing needs changing, return the text unchanged.";

export function buildSystem(rules: string): string {
  return `${INSTRUCTION}\n\nRules:\n${rules.trim()}`;
}

/** Strip accidental code-fence / quote wrapping from a model response. */
export function stripWrapping(s: string): string {
  let t = s.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') t = t.slice(1, -1);
  return t.trim();
}

/** One LLM turn: the response text, or null on any failure. */
export type LlmCall = (system: string, user: string, maxTokens: number) => Promise<string | null>;

export interface ApiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** An LlmCall through the Anthropic API with the user's own key. Runs in Node
 *  and in a browser extension; no retries, so a slow or failing call falls
 *  back to the offline rules within `timeoutMs`. */
export function anthropicCall(o: ApiOptions): LlmCall {
  const client = new Anthropic({
    apiKey: o.apiKey,
    timeout: o.timeoutMs,
    maxRetries: 0,
    // The user's own key in their own browser (the Chrome extension).
    dangerouslyAllowBrowser: true,
  });
  return async (system, user, maxTokens) => {
    try {
      const res = await client.messages.create({
        model: o.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      // Only a clean completion is usable; refusal or a max_tokens cut would
      // return text truncated mid-sentence — fall back to deterministic instead.
      if (res.stop_reason !== "end_turn") return null;
      const out = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return out ? stripWrapping(out) : null;
    } catch {
      return null;
    }
  };
}

/** ai mode for already pre-normalized text: rewrite with the LLM when there's
 *  anything to rewrite, else (or on failure) apply the built-in rules. */
export async function aiNormalize(pre: string, rules: string, call: LlmCall): Promise<string> {
  if (!hasCandidates(pre)) return deterministic(pre);
  const result = await call(
    buildSystem(rules),
    `Text to rewrite:\n${pre}`,
    // Char count as a token proxy: generous for English, safe for multibyte
    // text where chars≈tokens, so output isn't capped mid-sentence.
    Math.min(8192, pre.length + 256)
  );
  // Strip emphasis from the model's output too — a guaranteed floor so markers
  // are never spoken even if the model echoes them.
  return result ? stripEmphasis(result) : deterministic(pre);
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
