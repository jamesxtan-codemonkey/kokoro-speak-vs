// Light, deterministic text preparation. For now this only de-markdowns text so
// the preview/document case doesn't read syntax aloud ("hash", "asterisk").
// The richer LLM normalizer ($10B → ten billion dollars) lands in a later
// milestone; this is the structural cleanup that belongs before it.

export function stripMarkdown(md: string): string {
  let s = md.replace(/\r\n/g, "\n");

  // Fenced code blocks (``` and ~~~) — drop entirely.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");

  // Images ![alt](url) → alt; links [text](url) / [text][ref] → text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

  // Inline code `x` → x.
  s = s.replace(/`([^`]+)`/g, "$1");

  // Headings, blockquotes, list markers at line start.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "");

  // Horizontal rules and table separator rows → blank.
  s = s.replace(/^\s{0,3}([-*_] ?){3,}\s*$/gm, " ");
  s = s.replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, " ");
  s = s.replace(/\|/g, " ");

  // Emphasis / bold / strikethrough markers.
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  s = s.replace(/~~(.*?)~~/g, "$1");

  // Stray HTML tags.
  s = s.replace(/<[^>]+>/g, " ");

  // Tidy whitespace.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Text to speak for a document (or a selection within it), cleaned by type. */
export function getSpeakableText(languageId: string, raw: string): string {
  return languageId === "markdown" ? stripMarkdown(raw) : raw;
}
