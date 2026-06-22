// Light, deterministic text preparation: de-markdown prose, and for source code
// strip comment markers (or read only the comments) so syntax isn't spoken. The
// richer per-file-type normalization ($10B → ten billion dollars; operators /
// identifiers) runs after this, in normalize.ts.

import { profileFor, stripCodeForSpeech, CodeReading } from "./codeprep";

export function stripMarkdown(md: string): string {
  let s = md.replace(/\r\n/g, "\n");

  // --- block level (needs line breaks intact: line-start anchors) ---
  // Fenced code blocks (``` and ~~~) — drop entirely.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");
  // Headings: drop the marker (and any closing #'s) AND isolate the heading as
  // its own paragraph, so it isn't merged into the next line by the soft-break
  // unwrap below — a heading is spoken as its own phrase, with a pause.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "\n\n$1\n\n");
  // Blockquotes, list markers at line start.
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "");
  // Horizontal rules and table separator rows → blank. Use [ \t] (not \s, which
  // includes newlines and would swallow blank-line paragraph breaks).
  s = s.replace(/^[ \t]{0,3}([-*_] ?){3,}[ \t]*$/gm, " ");
  s = s.replace(/^[ \t]*\|?[-:| \t]+\|?[ \t]*$/gm, " ");
  s = s.replace(/\|/g, " ");

  // --- unwrap soft line breaks ---
  // Hard-wrapped source lines within a paragraph are a single newline (a
  // Markdown soft break = a space). Join them so the speech engine doesn't treat
  // each wrap as a sentence boundary (which adds a pause), AND so inline spans
  // (bold/italic/links) that straddle a wrap become contiguous for stripping
  // below. Blank lines (paragraph breaks) are preserved.
  s = s
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

  // --- inline level (now single-line per paragraph) ---
  // Images ![alt](url) → alt; links [text](url) / [text][ref] → text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Inline code `x` → x.
  s = s.replace(/`([^`]+)`/g, "$1");
  // Emphasis / bold / strikethrough markers. Asterisks in any context; the
  // underscore variants only at word boundaries — CommonMark does not treat
  // intra-word "_" as emphasis, so identifiers like snake_case / file_name
  // keep their underscores.
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/\*(?!\s)([^*]+?)(?<!\s)\*/g, "$1");
  s = s.replace(/(?<!\w)__(.+?)__(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1");
  s = s.replace(/~~(.+?)~~/g, "$1");
  // Stray HTML tags.
  s = s.replace(/<[^>]+>/g, " ");

  return s.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Text to speak for a document (or selection within it), cleaned by file type:
 *  - Markdown  → strip Markdown syntax.
 *  - Code      → strip comment markers (and, in "comments" mode, read only the
 *                comments) so `//`, `#`, `/* *​/` aren't spoken. See codeprep.
 *  - Plaintext → as-is.
 * `codeReading` only affects code languages.
 */
export function getSpeakableText(
  languageId: string,
  raw: string,
  codeReading: CodeReading = "all"
): string {
  if (profileFor(languageId) === "code") {
    return stripCodeForSpeech(raw, languageId, codeReading);
  }
  return languageId === "markdown" ? stripMarkdown(raw) : raw;
}
