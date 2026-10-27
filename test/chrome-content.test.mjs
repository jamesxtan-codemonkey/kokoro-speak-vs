// Minimal DOM doubles keep extraction/range regressions runnable without a GUI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const code = (await build({ entryPoints: ["chrome/src/content.ts"], bundle: true, format: "iife", write: false })).outputFiles[0].text;
const accessCode = (await build({ entryPoints: ["chrome/src/access.ts"], bundle: true, format: "cjs", write: false })).outputFiles[0].text;

class Text {
  nodeType = 3;
  isConnected = true;
  constructor(data) { this.data = data; }
  get length() { return this.data.length; }
  get textContent() { return this.data; }
  get previousSibling() { const a = this.parentElement.children; return a[a.indexOf(this) - 1] ?? null; }
}
class Element {
  nodeType = 1;
  children = [];
  style = {};
  attrs = {};
  className = "";
  constructor(tag, ...children) {
    this.tagName = tag.toUpperCase();
    for (const child of children) this.append(typeof child === "string" ? new Text(child) : child);
  }
  append(child) { this.children.push(child); child.parentElement = this; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get previousSibling() { const a = this.parentElement.children; return a[a.indexOf(this) - 1] ?? null; }
  get textContent() {
    const parts = [], stack = [...this.children].reverse();
    while (stack.length) { const n = stack.pop(); if (n.nodeType === 3) parts.push(n.data); else stack.push(...[...n.children].reverse()); }
    return parts.join("");
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  checkVisibility() { return this.style.display !== "contents" && this.style.display !== "none"; }
  getBoundingClientRect() { return { width: 500, height: 30 }; }
  contains(n) { for (; n; n = n.parentElement) if (n === this) return true; return false; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map((s) => s.trim().toUpperCase());
    const out = [], stack = [...this.children].reverse();
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType !== 1) continue;
      if (tags.includes(n.tagName)) out.push(n);
      stack.push(...[...n.children].reverse());
    }
    return out;
  }
}
class Input extends Element { constructor() { super("input"); } }
class TextArea extends Element { constructor() { super("textarea"); } }
class IFrame extends Element { constructor() { super("iframe"); } }

function page(...children) {
  const body = new Element("body", ...children);
  const registry = new Map(), events = new Map(), sent = [];
  let listener;
  const doc = {
    body, activeElement: body,
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelectorAll(s)[0] ?? null,
    createRange() {
      return {
        setStart(n, offset) { if (offset > n.length) throw new Error("changed text"); this.startContainer = n; this.startOffset = offset; },
        setEnd(n, offset) { if (offset > n.length) throw new Error("changed text"); this.endContainer = n; this.endOffset = offset; },
      };
    },
  };
  const ctx = {
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLIFrameElement: IFrame,
    document: doc, location: new URL("https://example.com/article"), URL,
    Highlight: class extends Set {}, CSS: { highlights: registry },
    getComputedStyle: (el) => ({ display: el.tagName === "SPAN" ? "inline" : "block", whiteSpace: "normal", visibility: "visible", position: "static", ...el.style }),
    getSelection: () => ctx.selection,
    addEventListener: (name, f) => events.set(name, f),
    chrome: { runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`, onMessage: { addListener(f) { listener = f; } }, async sendMessage(m) { sent.push(m); } } },
  };
  ctx.window = ctx;
  runInNewContext(code, ctx);
  return {
    doc, body, sent, events, highlight: registry.get("kokoro-speak"), extract: ctx.__kokoroSpeak.extract,
    select(n, start = 0, end = n.nodeType === 3 ? n.length : n.children.length) {
      const r = { commonAncestorContainer: n, startContainer: n, startOffset: start, endContainer: n, endOffset: end, intersectsNode: () => true };
      ctx.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => r, toString: () => n.textContent };
    },
    message(m) { listener(m, { id: "test", url: "chrome-extension://test/background.js" }); },
  };
}

test("Chrome: display:contents wrappers retain rendered text", () => {
  const wrapper = new Element("div", new Element("p", "This text is rendered."));
  wrapper.style.display = "contents";
  const p = page(wrapper);
  assert.equal(p.extract("page", 1).text.trim(), "This text is rendered.");
});

test("Chrome: selections respect hidden ancestors and page candidates skip asides", () => {
  const hidden = new Element("div", new Element("p", "Secret selected text."));
  hidden.attrs["aria-hidden"] = "true";
  const article = new Element("article", new Element("p", "The readable article has enough prose to choose it as the page content."));
  const aside = new Element("aside", new Element("article", new Element("p", "Unrelated sidebar. ".repeat(100))));
  const p = page(hidden, article, aside);
  p.select(hidden.firstChild.firstChild);
  assert.equal(p.extract("selection", 1).text, "");
  const text = p.extract("page", 2).text;
  assert.match(text, /readable article/);
  assert.doesNotMatch(text, /Secret|sidebar/);
});

test("Chrome: pre-line collapses spaces while keeping line breaks", () => {
  const el = new Element("p", "Hello   there\nnext   line");
  el.style.whiteSpace = "pre-line";
  const p = page(el);
  p.select(el);
  assert.equal(p.extract("selection", 1).text, "Hello there\nnext line\n");
});

test("Chrome: search-field selections and focused frames beat stale page selections", () => {
  const input = new Input();
  Object.assign(input, { type: "search", value: "Find this text", selectionStart: 5, selectionEnd: 9 });
  const p = page(new Element("p", "Old selection."), input);
  p.doc.activeElement = input;
  assert.equal(p.extract("selection", 1).text, "this");
  const frame = new IFrame();
  frame.src = "https://frames.example.net/page";
  p.doc.activeElement = frame;
  p.select(p.body.firstChild.firstChild);
  const found = p.extract("selection", 2);
  assert.equal(found.text, "");
  assert.equal(found.frame, "https://frames.example.net");
});

test("Chrome: UTF-16 ranges stay tied to their extraction and release on completion", () => {
  const el = new Element("p", "😀 Hello there.");
  const p = page(el), text = el.firstChild;
  p.select(text, 3, text.length);
  p.extract("selection", 1);
  p.extract("selection", 2);
  const progress = { type: "kokoro:highlight", start: 0, end: 5, autoScroll: false };
  p.message({ ...progress, jobId: 1 });
  assert.equal(p.highlight.size, 0);
  p.message({ ...progress, jobId: 2 });
  assert.equal([...p.highlight][0].startOffset, 3);
  assert.equal([...p.highlight][0].endOffset, 8);
  p.message({ type: "kokoro:clear", jobId: 1 });
  assert.equal(p.highlight.size, 1);
  p.message({ type: "kokoro:clear", jobId: 2, release: false });
  p.message({ ...progress, jobId: 2 });
  assert.equal(p.highlight.size, 1, "toggling highlighting retains the map");
  p.message({ type: "kokoro:clear", jobId: 2 });
  p.message({ ...progress, jobId: 2 });
  assert.equal(p.highlight.size, 0, "completion releases the map");
});

test("Chrome: stale DOM offsets clear the old highlight and pagehide reports unloading", () => {
  const el = new Element("p", "Hello there.");
  const p = page(el);
  p.select(el.firstChild);
  p.extract("selection", 1);
  const m = { type: "kokoro:highlight", jobId: 1, start: 0, end: 5, autoScroll: false };
  p.message(m);
  assert.equal(p.highlight.size, 1);
  el.firstChild.data = "x";
  p.message(m);
  assert.equal(p.highlight.size, 0);
  p.events.get("pagehide")();
  assert.equal(p.sent.at(-1).type, "page-hidden");
});

test("Chrome: deeply nested page markup does not overflow extraction's stack", () => {
  const root = new Element("div");
  let el = root;
  for (let i = 0; i < 15000; i++) { const child = new Element("div"); el.append(child); el = child; }
  el.append(new Text("Deep text."));
  const p = page(root);
  p.select(root);
  assert.equal(p.extract("selection", 1).text.trim(), "Deep text.");
});

test("Chrome: random subdomains do not grant access to an entire hosting service", () => {
  const module = { exports: {} };
  runInNewContext(accessCode, { module, exports: module.exports, URL });
  const { accessRequest } = module.exports;
  assert.equal(accessRequest("https://0123456789abcdef.github.io").pattern, "https://0123456789abcdef.github.io/*");
  assert.equal(accessRequest("https://0123456789abcdef.frame.claudeusercontent.com").pattern, "https://*.frame.claudeusercontent.com/*");
});
