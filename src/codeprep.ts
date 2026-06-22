// Per-file-type speech preparation for source code. Maps a VS Code languageId to
// a normalization "profile" (prose vs code) and, for code, segments the text into
// comments / strings / code so we can read it sensibly: strip comment markers so
// `//` and `/* */` aren't spoken, and optionally read *only* the comments. Pure
// logic, no `vscode` import — unit-tested in Node.

import type { Profile } from "./normalize";

export type { Profile };

// Languages we treat as prose (no code segmentation; Markdown is stripped
// separately). Everything else is treated as code.
const PROSE_LANGS = new Set([
  "",
  "markdown",
  "plaintext",
  "asciidoc",
  "restructuredtext",
  "latex",
  "tex",
  "bibtex",
  "log",
]);

/** Normalization profile for a languageId: "prose" or "code". */
export function profileFor(languageId: string): Profile {
  return PROSE_LANGS.has(languageId) ? "prose" : "code";
}

export interface Syntax {
  line: string[]; // line-comment starters, e.g. ["//"]
  block: Array<[string, string]>; // block-comment pairs, e.g. [["/*","*/"]]
  strings: string[]; // string delimiters (longest first so `"""` beats `"`)
}

const C_LIKE: Syntax = {
  line: ["//"],
  block: [["/*", "*/"]],
  strings: ['"', "'", "`"],
};
const HASH: Syntax = { line: ["#"], block: [], strings: ['"', "'"] };

// languageId → comment/string syntax. Unlisted code languages fall back to
// C_LIKE (// and /* */), which covers the large C-family majority.
const SYNTAX: Record<string, Syntax> = {
  c: C_LIKE, cpp: C_LIKE, csharp: C_LIKE, java: C_LIKE, javascript: C_LIKE,
  javascriptreact: C_LIKE, typescript: C_LIKE, typescriptreact: C_LIKE,
  go: C_LIKE, rust: C_LIKE, swift: C_LIKE, kotlin: C_LIKE, scala: C_LIKE,
  dart: C_LIKE, "objective-c": C_LIKE, "objective-cpp": C_LIKE, json: C_LIKE,
  jsonc: C_LIKE, groovy: C_LIKE, solidity: C_LIKE, zig: C_LIKE,
  php: { line: ["//", "#"], block: [["/*", "*/"]], strings: ['"', "'"] },
  css: { line: [], block: [["/*", "*/"]], strings: ['"', "'"] },
  scss: { line: ["//"], block: [["/*", "*/"]], strings: ['"', "'"] },
  less: { line: ["//"], block: [["/*", "*/"]], strings: ['"', "'"] },
  python: { line: ["#"], block: [], strings: ['"""', "'''", '"', "'"] },
  ruby: { line: ["#"], block: [["=begin", "=end"]], strings: ['"', "'"] },
  shellscript: HASH, powershell: { line: ["#"], block: [["<#", "#>"]], strings: ['"', "'"] },
  yaml: HASH, toml: HASH, ini: HASH, dockerfile: HASH, makefile: HASH,
  cmake: HASH, r: HASH, perl: HASH, elixir: HASH, julia: HASH,
  sql: { line: ["--"], block: [["/*", "*/"]], strings: ["'", '"'] },
  lua: { line: ["--"], block: [["--[[", "]]"]], strings: ['"', "'"] },
  haskell: { line: ["--"], block: [["{-", "-}"]], strings: ['"'] },
  clojure: { line: [";"], block: [], strings: ['"'] },
  lisp: { line: [";"], block: [], strings: ['"'] },
  html: { line: [], block: [["<!--", "-->"]], strings: ['"', "'"] },
  xml: { line: [], block: [["<!--", "-->"]], strings: ['"', "'"] },
  vue: { line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]], strings: ['"', "'", "`"] },
};

export function syntaxFor(languageId: string): Syntax {
  return SYNTAX[languageId] ?? C_LIKE;
}

export interface Segment {
  kind: "code" | "comment" | "string";
  text: string;
}

/**
 * Split source into ordered code / comment / string segments. A single forward
 * scan: at each position, a string opener wins only if no comment opener matches
 * there, so `//` inside a string is never seen as a comment, and a quote inside a
 * line comment is never seen as a string. Unterminated runs extend to EOF (or to
 * end-of-line for single-char strings).
 */
export function segmentCode(src: string, syn: Syntax): Segment[] {
  const segs: Segment[] = [];
  let i = 0;
  let codeStart = 0;
  const n = src.length;
  const pushCode = (end: number) => {
    if (end > codeStart) segs.push({ kind: "code", text: src.slice(codeStart, end) });
  };

  while (i < n) {
    let matched = false;

    // Block comments before line comments: when a line delimiter is a prefix of
    // a block delimiter (Lua `--` vs `--[[`), the block must win so a multi-line
    // block isn't cut off at its first newline.
    for (const [open, close] of syn.block) {
      if (src.startsWith(open, i)) {
        pushCode(i);
        let j = src.indexOf(close, i + open.length);
        j = j === -1 ? n : j + close.length;
        segs.push({ kind: "comment", text: src.slice(i, j) });
        i = codeStart = j;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    for (const lc of syn.line) {
      if (src.startsWith(lc, i)) {
        pushCode(i);
        let j = src.indexOf("\n", i);
        if (j === -1) j = n;
        segs.push({ kind: "comment", text: src.slice(i, j) });
        i = codeStart = j;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    for (const q of syn.strings) {
      if (src.startsWith(q, i)) {
        pushCode(i);
        let j = i + q.length;
        if (q.length === 1) {
          while (j < n) {
            if (src[j] === "\\") { j += 2; continue; }
            if (src[j] === "\n") break; // unterminated single-line string
            if (src[j] === q) { j += 1; break; }
            j += 1;
          }
        } else {
          const k = src.indexOf(q, j);
          j = k === -1 ? n : k + q.length;
        }
        segs.push({ kind: "string", text: src.slice(i, j) });
        i = codeStart = j;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    i += 1;
  }
  pushCode(n);
  return segs;
}

/** Strip a comment segment's delimiters, leaving the human text. */
function cleanComment(text: string, syn: Syntax): string {
  let s = text;
  for (const [open, close] of syn.block) {
    if (s.startsWith(open)) {
      s = s.slice(open.length);
      if (s.endsWith(close)) s = s.slice(0, -close.length);
    }
  }
  for (const lc of syn.line) {
    if (s.startsWith(lc)) {
      s = s.slice(lc.length);
      break;
    }
  }
  // Drop the leading "*" decoration common in /* ... */ doc blocks.
  s = s.replace(/^[ \t]*\*[ \t]?/gm, "");
  return s.trim();
}

/** Strip surrounding quotes from a string literal segment. */
function cleanString(text: string, syn: Syntax): string {
  for (const q of syn.strings) {
    if (text.startsWith(q) && text.endsWith(q) && text.length >= q.length * 2) {
      return text.slice(q.length, text.length - q.length).trim();
    }
  }
  return text.trim();
}

export type CodeReading = "all" | "comments";

/**
 * Prepare source code for speech.
 *  - "all": read everything, but with comment markers removed so `//`, `#`,
 *    `/* *​/` etc. aren't spoken. Layout (and code) is otherwise preserved.
 *  - "comments": read ONLY comments and docstrings (code and string literals are
 *    skipped) — for listening to the prose/explanations in a file.
 */
export function stripCodeForSpeech(
  src: string,
  languageId: string,
  mode: CodeReading = "all"
): string {
  const syn = syntaxFor(languageId);
  const segs = segmentCode(src, syn);

  if (mode === "comments") {
    // Comments, plus docstrings — triple-quoted strings (Python `"""`/`'''`),
    // which carry human-readable documentation.
    const isDocstring = (t: string) => /^("""|''')/.test(t);
    return segs
      .filter((s) => s.kind === "comment" || (s.kind === "string" && isDocstring(s.text)))
      .map((s) => (s.kind === "comment" ? cleanComment(s.text, syn) : cleanString(s.text, syn)))
      .filter(Boolean)
      .join("\n");
  }

  // "all": rebuild verbatim, but with comment markers stripped. A comment becomes
  // its own sentence (". ") so it isn't run together with adjacent code.
  let out = "";
  for (const s of segs) {
    if (s.kind === "comment") {
      const c = cleanComment(s.text, syn);
      out += c ? ` ${c}. ` : " ";
    } else {
      out += s.text;
    }
  }
  return out;
}
