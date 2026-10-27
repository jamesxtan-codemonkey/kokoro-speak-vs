// Content script, injected on demand (activeTab) into the page being read.
// Turns the selection, or the page's main article, into plain text with a
// per-character map back to DOM text nodes, then highlights the range being
// spoken with the CSS Custom Highlight API (no changes to the page's DOM).
//
// Text follows what's rendered: whitespace collapses as in normal flow (kept in
// <pre>), block elements and <br> become line breaks (which the chunker treats
// as sentence breaks, so headings and list items are read on their own), and
// hidden, decorative or form elements are skipped.

import type { Extracted, ToContent } from "./messages";

type Mode = "selection" | "page";

const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED",
  "VIDEO", "AUDIO", "SELECT", "INPUT", "TEXTAREA", "BUTTON", "MATH", "HEAD",
]);
// Page chrome left out of "Read page" (a selection reads whatever is selected).
const PAGE_SKIP = new Set(["NAV", "ASIDE", "FOOTER", "FORM", "FIGURE", "DIALOG"]);
const PAGE_SKIP_ROLES = /^(navigation|banner|contentinfo|complementary|search|dialog|alert)$/;
const PAGE_SKIP_CLASS = /(^|[\s_-])(mw-editsection|noprint|share|social|related|comments?|advert|ads?|sponsored|newsletter|cookie|breadcrumbs?)([\s_-]|$)/i;

class Builder {
  text = "";
  nodes: (Text | null)[] = [];
  offsets: number[] = [];
  private space: [Text, number] | null = null;
  private lineStart = true;

  private push(ch: string, node: Text | null, offset: number) {
    this.text += ch;
    this.nodes.push(node);
    this.offsets.push(offset);
  }

  newline() {
    this.space = null;
    if (!this.lineStart) this.push("\n", null, 0);
    this.lineStart = true;
  }

  add(node: Text, start: number, end: number, pre: boolean) {
    const data = node.data;
    for (let i = start; i < end; i++) {
      const ch = data[i];
      if (pre && ch === "\n") {
        this.newline();
      } else if (!pre && /\s/.test(ch)) {
        if (!this.lineStart && !this.space) this.space = [node, i];
      } else {
        if (this.space) this.push(" ", ...this.space);
        this.space = null;
        this.push(ch, node, i);
        this.lineStart = false;
      }
    }
  }
}

function visible(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) return false;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true } as any)) {
    return false;
  }
  // Visually hidden "screen reader only" text (clipped to a pixel).
  const r = el.getBoundingClientRect();
  return !(r.width <= 1 && r.height <= 1 && getComputedStyle(el).position === "absolute");
}

function skipOnPage(el: Element): boolean {
  if (PAGE_SKIP.has(el.tagName)) return true;
  const role = el.getAttribute("role");
  if (role && PAGE_SKIP_ROLES.test(role)) return true;
  if (typeof el.className === "string" && PAGE_SKIP_CLASS.test(el.className)) return true;
  // Footnote markers such as "[1]" or "[citation needed]".
  if (el.tagName === "SUP" && /^\s*\[[^\]]{1,24}\]\s*$/.test(el.textContent ?? "")) return true;
  return false;
}

function walk(node: Node, b: Builder, mode: Mode, range: Range | null) {
  if (range && !range.intersectsNode(node)) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node as Text;
    const start = range && t === range.startContainer ? range.startOffset : 0;
    const end = range && t === range.endContainer ? range.endOffset : t.length;
    const ws = t.parentElement ? getComputedStyle(t.parentElement).whiteSpace : "normal";
    b.add(t, start, end, ws.startsWith("pre") || ws === "break-spaces");
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (SKIP.has(el.tagName.toUpperCase()) || !visible(el)) return;
  if (mode === "page" && skipOnPage(el)) return;
  if (el.tagName === "BR") {
    b.newline();
    return;
  }
  const display = getComputedStyle(el).display;
  const block = !display.startsWith("inline") && display !== "contents";
  if (block) b.newline();
  for (let c = el.firstChild; c; c = c.nextSibling) walk(c, b, mode, range);
  if (block) b.newline();
}

/** Text of <p>-like descendants: how much readable prose an element holds. */
function proseLength(el: Element): number {
  let n = 0;
  for (const p of el.querySelectorAll("p, li, pre, blockquote, dd")) n += p.textContent?.trim().length ?? 0;
  return n;
}

/** The element holding the page's main text. */
function articleRoot(): Element {
  const semantic = [...document.querySelectorAll("article, main, [role=main], [itemprop=articleBody]")].filter(visible);
  let best = null as Element | null;
  let bestLen = 0;
  for (const el of semantic) {
    const len = proseLength(el);
    // Prefer the innermost candidate holding most of the prose.
    const inner = best !== null && best.contains(el) && len >= bestLen * 0.8;
    if (len > bestLen * 1.25 || inner) {
      best = el;
      bestLen = len;
    }
  }
  if (best && bestLen >= 400) return best;

  // No usable landmark: the element whose paragraphs hold the most text
  // (parents score a paragraph's length, grandparents half of it).
  const score = new Map<Element, number>();
  for (const p of document.querySelectorAll("p")) {
    const len = p.textContent?.trim().length ?? 0;
    if (len < 40 || !visible(p)) continue;
    const parent = p.parentElement;
    if (parent) score.set(parent, (score.get(parent) ?? 0) + len);
    const grand = parent?.parentElement;
    if (grand) score.set(grand, (score.get(grand) ?? 0) + len / 2);
  }
  let top: Element | null = null;
  let topScore = 0;
  for (const [el, s] of score) if (s > topScore) [top, topScore] = [el, s];
  return top ?? document.body;
}

interface Model {
  b: Builder;
}
let model: Model | null = null;

/** The origin of the embedded frame that has the focus, if it's another site's:
 *  a selection made there isn't visible from this page. */
function focusedFrameOrigin(): string | undefined {
  const el = document.activeElement;
  if (!(el instanceof HTMLIFrameElement)) return undefined;
  try {
    const origin = new URL(el.src, location.href).origin;
    return origin !== "null" && origin !== location.origin ? origin : undefined;
  } catch {
    return undefined;
  }
}

function extract(mode: Mode): Extracted {
  clear();
  const b = new Builder();
  if (mode === "selection") {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === "text")) {
      model = null;
      const text = active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0);
      return { text, mapped: false };
    }
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return { text: "", mapped: false, frame: focusedFrameOrigin() };
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      walk(r.commonAncestorContainer, b, "selection", r);
      b.newline();
    }
    if (!b.text.trim()) {
      // e.g. a selection inside a shadow root: read it, without highlighting.
      model = null;
      return { text: sel.toString(), mapped: false };
    }
  } else {
    const root = articleRoot();
    // Read the page's title too when the article element doesn't include it.
    const h1 = document.querySelector("h1");
    if (h1 && !root.contains(h1) && visible(h1)) walk(h1, b, mode, null);
    walk(root, b, mode, null);
  }
  model = { b };
  return { text: b.text, mapped: true };
}

// ---- highlighting ----------------------------------------------------------

let highlight: Highlight | null = null;
let lastUserScroll = 0;

/** The DOM position of model character `i`, searching `dir` past separators. */
function position(i: number, dir: 1 | -1): [Text, number] | null {
  const b = model?.b;
  if (!b) return null;
  for (let k = i; k >= 0 && k < b.nodes.length; k += dir) {
    const n = b.nodes[k];
    if (n) return [n, b.offsets[k]];
  }
  return null;
}

function show(start: number, end: number, autoScroll: boolean) {
  if (!highlight || !model) return;
  const s = position(start, 1);
  const e = position(end - 1, -1);
  if (!s || !e || !s[0].isConnected || !e[0].isConnected) return;
  const r = document.createRange();
  try {
    r.setStart(s[0], s[1]);
    r.setEnd(e[0], e[1] + 1);
  } catch {
    return; // the page changed under us
  }
  highlight.clear();
  highlight.add(r);
  // Keep the spoken sentence in view, unless the user is scrolling around.
  if (autoScroll && Date.now() - lastUserScroll > 4000) {
    const rect = r.getBoundingClientRect();
    if (rect.height && (rect.top < 0 || rect.bottom > innerHeight)) {
      scrollBy({ top: rect.top - innerHeight / 3, behavior: "smooth" });
    }
  }
}

function clear() {
  highlight?.clear();
}

declare global {
  interface Window {
    __kokoroSpeak?: { extract(mode: Mode): Extracted };
  }
}

// Injected again on every use: set up once, and keep the first copy's state.
if (!window.__kokoroSpeak) {
  window.__kokoroSpeak = { extract };
  if (typeof Highlight === "function") {
    highlight = new Highlight();
    CSS.highlights.set("kokoro-speak", highlight);
  }
  for (const ev of ["wheel", "touchmove", "keydown"]) addEventListener(ev, () => (lastUserScroll = Date.now()), { passive: true });
  chrome.runtime.onMessage.addListener((m: ToContent) => {
    if (m.type === "kokoro:highlight") show(m.start, m.end, m.autoScroll);
    else if (m.type === "kokoro:clear") clear();
  });
}
