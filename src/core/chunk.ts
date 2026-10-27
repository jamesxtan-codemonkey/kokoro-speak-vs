// Text chunking for synthesis, shared by the VS Code and Chrome extensions.
// Pure (no Node or DOM APIs).
//
// Kokoro truncates any single generation past its ~512-token cap. Kokoro's own
// TextSplitterStream batches greedily and can hand the model an over-long chunk
// (e.g. when sentence detection misses `." ` or a lowercase follower), silently
// dropping the tail. So we chunk the text ourselves and generate per chunk, with
// each chunk kept well under the cap.

export const MAX_CHUNK_CHARS = 250;

/** A chunk to synthesize, and the range of the input it came from. Inside a
 *  chunk, whitespace where a long sentence was packed collapses to one space,
 *  so `text` can be shorter than `end - start`. */
export interface Chunk {
  text: string;
  start: number;
  end: number;
}

type Span = [number, number];

const SENTENCE_BREAK = /(?<=[.!?]["')\]]?)\s+/g;
const LINE_BREAK = /\n+/g;
// Clause breaks to try, strongest first, before falling back to bare word
// boundaries. Each chunk is voiced as its own utterance (closing intonation
// plus edge silence), so a seam at a word boundary sounds like a stray pause
// mid-phrase ("the outcome, its | reason"); a seam at a clause break lands
// where a reader would pause anyway.
const CLAUSE_BREAKS = [/(?<=[;:—–])\s+|\s+(?=[—–]\s)/g, /(?<=,)\s+/g];
const WORD_BREAK = /\s+/g;

/** `String.split(re)` over text[start, end), as spans of the original text. */
function split(text: string, [start, end]: Span, re: RegExp): Span[] {
  const s = text.slice(start, end);
  const out: Span[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out.push([start + last, start + m.index]);
    last = m.index + m[0].length;
  }
  out.push([start + last, end]);
  return out;
}

function trim(text: string, [start, end]: Span): Span {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

/** Greedily joins spans with single spaces into chunks of <= maxChars. */
class Packer {
  out: Chunk[] = [];
  private cur: Chunk | null = null;
  constructor(private text: string, private maxChars: number) {}

  /** Appends `span` to the current chunk if it fits, else starts a new one. */
  add([start, end]: Span) {
    const piece = this.text.slice(start, end);
    if (this.cur?.text && this.cur.text.length + 1 + piece.length <= this.maxChars) {
      this.cur.text += " " + piece;
      this.cur.end = end;
    } else {
      this.flush();
      this.cur = { text: piece, start, end };
    }
  }

  /** Emits a chunk as-is, ending the current one. */
  emit(c: Chunk) {
    this.flush();
    this.out.push(c);
  }

  flush() {
    if (this.cur?.text) this.out.push(this.cur);
    this.cur = null;
  }
}

/** Greedily pack a long sentence into <=maxChars pieces at word boundaries
 *  (hard-splitting any single oversized token). */
function packWords(text: string, span: Span, maxChars: number): Chunk[] {
  const p = new Packer(text, maxChars);
  for (let [start, end] of split(text, span, WORD_BREAK)) {
    while (end - start > maxChars) {
      p.emit({ text: text.slice(start, start + maxChars), start, end: start + maxChars });
      start += maxChars;
    }
    p.add([start, end]);
  }
  p.flush();
  return p.out;
}

/** Split an over-long sentence into <=maxChars chunks, cutting at the
 *  strongest clause break that fits and word-packing only as a last resort. */
function packClauses(text: string, span: Span, maxChars: number, level = 0): Chunk[] {
  if (span[1] - span[0] <= maxChars) return [{ text: text.slice(...span), start: span[0], end: span[1] }];
  if (level >= CLAUSE_BREAKS.length) return packWords(text, span, maxChars);
  const p = new Packer(text, maxChars);
  for (const clause of split(text, span, CLAUSE_BREAKS[level])) {
    if (clause[1] - clause[0] <= maxChars) p.add(clause);
    else for (const c of packClauses(text, clause, maxChars, level + 1)) p.emit(c);
  }
  p.flush();
  return p.out;
}

/**
 * Split text into synthesis-sized chunks so no single Kokoro generation exceeds
 * its token cap (which would truncate, dropping the tail). Splits on sentence
 * boundaries — `.`/`!`/`?` optionally followed by a closing quote/paren, then
 * whitespace, plus newlines — then cuts any still-too-long sentence at clause
 * breaks, word-packing only a clause that is itself too long.
 */
export function chunkSpans(text: string, maxChars = MAX_CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  for (const sentence of split(text, [0, text.length], SENTENCE_BREAK)) {
    for (const line of split(text, sentence, LINE_BREAK)) {
      const span = trim(text, line);
      if (span[0] === span[1]) continue;
      chunks.push(...packClauses(text, span, maxChars));
    }
  }
  return chunks;
}

export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  return chunkSpans(text, maxChars).map((c) => c.text);
}
