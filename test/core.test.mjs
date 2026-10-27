// Tests for the shared core (src/core), beyond what synth/normalize tests cover:
// chunk positions, and normalization that keeps a map back to the input (the
// Chrome extension highlights the source text of each spoken chunk).
// Bundled to test/.core.cjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chunkSpans, chunkText, normalizeMapped, preNormalize, deterministic, MappedText, anthropicCall } = require("./.core.cjs");

const PARAGRAPH =
  "Every case figure reuses the stage column on the left, title for title from Figure 1 of the architecture page. A case is a column to its right. A data item sits in the row of the stage it enters; the case's flow runs down the column in the accent, labelled where something happens; a stage the case does not run is written as such; and the outcome box at the foot carries the outcome, its reason, rule id, review reasons, and what the trace records, in the use case's words.";

test("chunkSpans: each chunk's range is its source text", () => {
  const text = "First line\nsecond line.  Third   sentence here!\n\n" + PARAGRAPH;
  const chunks = chunkSpans(text);
  assert.deepEqual(chunks.map((c) => c.text), chunkText(text));
  for (const c of chunks) {
    assert.equal(text.slice(c.start, c.end).replace(/\s+/g, " "), c.text.replace(/\s+/g, " "));
  }
});

test("chunkSpans: a packed long sentence keeps clause-break ranges", () => {
  const chunks = chunkSpans(PARAGRAPH);
  const last = chunks.at(-1);
  assert.equal(PARAGRAPH.slice(last.start, last.end), last.text);
  assert.ok(last.text.startsWith("and the outcome box"));
});

const CORPUS = [
  "Raised $10B in Q4 2025, up 50% (e.g. vs. last year).",
  "Use v1.2.3 → v2.0, about ~100 events; 5-20% of 2026-06-16.",
  "**Bold** and _italic_ ✅ done 🚀 & more @home 1,234,567 items.",
  "Dr. Smith met Mr. Jones at 345k sites; ranges 3–5 and 10—20.",
  "plain text with nothing to change",
  "  padded  \t text with   spaces  ",
];

test("normalizeMapped produces exactly the plain normalization", () => {
  const rules = { replacements: [{ from: "K8s", to: "Kubernetes" }, { pattern: "(\\d+)x", replacement: "$1 times" }], spellOut: ["API"] };
  for (const t of [...CORPUS, "K8s API runs 3x faster"]) {
    assert.equal(normalizeMapped(t, "deterministic", rules).text, deterministic(preNormalize(t, rules)), t);
  }
  assert.equal(normalizeMapped(CORPUS[0], "off", {}).text, CORPUS[0]);
});

test("normalizeMapped maps rewritten words back to what they replaced", () => {
  const src = "Revenue hit $10B in Q4 2025.";
  const mt = normalizeMapped(src, "deterministic", {});
  assert.equal(mt.text, "Revenue hit 10 billion dollars in fourth quarter 2025.");
  const at = (word) => {
    const i = mt.text.indexOf(word);
    const [s, e] = mt.source(i, i + word.length);
    return src.slice(s, e);
  };
  assert.equal(at("10 billion dollars"), "$10B");
  assert.equal(at("fourth quarter 2025"), "Q4 2025");
  assert.equal(at("Revenue"), "Revenue");
  assert.equal(at("2025."), "Q4 2025.");
});

test("normalizeMapped keeps abbreviations from splitting sentences", () => {
  const src = "Pick one, e.g. this one. Then stop.";
  const mt = normalizeMapped(src, "deterministic", {});
  const chunks = chunkSpans(mt.text).map((c) => src.slice(...mt.source(c.start, c.end)));
  assert.deepEqual(chunks, ["Pick one, e.g. this one.", "Then stop."]);
});

test("MappedText.replace substitutes like String.replace", () => {
  const cases = [
    ["a1b22c333", /(\d+)/g, "<$1>"],
    ["a1b22c333", /\d+/g, "[$&]"],
    ["2026-06-16", /(?<y>\d{4})-(?<m>\d\d)/g, "$<m>/$<y>"],
    ["cost $5", /\$(\d)/g, "$$$1"],
    ["x12y", /(\d)(\d)/g, "$2$1$10"],
    ["abc", /b/g, "[$`|$']"],
  ];
  for (const [s, re, to] of cases) assert.equal(MappedText.of(s).replace(re, to).text, s.replace(re, to), `${s} ${re} ${to}`);
});

test("Anthropic calls keep the configured key on the official API host", async (t) => {
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = "https://unrelated.example/";
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
  });
  let called;
  t.mock.method(globalThis, "fetch", async (url) => {
    called = String(url);
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "one dollar" }] }), { headers: { "content-type": "application/json" } });
  });
  const result = await anthropicCall({ apiKey: "test-key", model: "test", timeoutMs: 1000 })("Rewrite", "$1", 256);
  assert.equal(result, "one dollar");
  assert.equal(new URL(called).origin, "https://api.anthropic.com");
});
