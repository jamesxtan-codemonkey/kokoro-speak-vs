// Tests for chunkText — the splitter that keeps each Kokoro generation under the
// model's ~512-token cap (over-long generations get truncated, dropping the
// tail) — and for backend planning, tokenization and voice-row selection. Pure functions;
// bundled to test/.synth.cjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chunkText, planBackends, gpuDevice, tokenize, styleRow } = require("./.synth.cjs");

// The exact text from the bug report (a clause was dropped because Kokoro's own
// splitter merged 4 sentences into one over-long, truncated generation).
const BUG_TEXT =
  "What's actually wrong: Your gbrain runs in local-stdio MCP mode, so the MCP server process (PID 85394) holds the pglite database open. pglite is single-writer — gbrain's own docs say \"stop 'gbrain serve' before a large sync.\" So the /sync-gbrain CLI orchestrator can't get the lock, times out, and gets misclassified as broken-config (it's not — your config is valid and the engine is healthy; I verified via the MCP path). That misclassification is why it skipped the code + memory stages and only ran the no-op brain-sync.";

test("chunkText keeps every chunk under the cap (no over-long generation)", () => {
  const chunks = chunkText(BUG_TEXT);
  for (const c of chunks) {
    assert.ok(c.length <= 250, `chunk too long (${c.length}): ${c.slice(0, 50)}…`);
  }
});

test("chunkText preserves all words — nothing dropped", () => {
  const chunks = chunkText(BUG_TEXT);
  const joined = chunks.join(" ").replace(/\s+/g, " ").trim();
  const original = BUG_TEXT.replace(/\s+/g, " ").trim();
  assert.equal(joined, original, "rejoined chunks must equal the original text");
  // the specific clause that was dropped must survive, intact, within one chunk
  assert.ok(
    chunks.some((c) => c.includes("the engine is healthy; I verified via the MCP path")),
    "the previously-dropped clause must be wholly inside a single chunk"
  );
});

test("chunkText splits on sentence boundaries incl. closing quote/paren", () => {
  // `." So` (period inside a quote) and `). That` must both split.
  const chunks = chunkText('He said "go now." So we left. The end (done). That works.');
  assert.deepEqual(chunks, [
    'He said "go now."',
    "So we left.",
    "The end (done).",
    "That works.",
  ]);
});

test("chunkText word-packs an over-long single sentence", () => {
  const long = "word ".repeat(120).trim() + "."; // ~600 chars, no sentence breaks
  const chunks = chunkText(long);
  assert.ok(chunks.length > 1, "an over-long run-on must be split");
  for (const c of chunks) assert.ok(c.length <= 250);
  // no word is lost
  const wordCount = chunks.join(" ").split(/\s+/).filter(Boolean).length;
  assert.equal(wordCount, 120);
});

test("chunkText handles empty/whitespace input", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n  "), []);
});

test("gpuDevice: DirectML on Windows, none elsewhere", () => {
  assert.equal(gpuDevice("win32"), "dml");
  assert.equal(gpuDevice("darwin"), undefined);
  assert.equal(gpuDevice("linux"), undefined);
});

test("planBackends: Windows auto tries the DirectML vocoder first, then CPU", () => {
  assert.deepEqual(planBackends({ device: "auto" }, "win32"), [{ device: "dml" }, { device: "cpu" }]);
});

test("planBackends: device cpu skips the GPU", () => {
  assert.deepEqual(planBackends({ device: "cpu" }, "win32"), [{ device: "cpu" }]);
});

test("planBackends: macOS auto is CPU, and that is not a fallback", () => {
  const plan = planBackends({ device: "auto" }, "darwin");
  assert.deepEqual(plan, [{ device: "cpu" }]);
});

test("planBackends: device gpu without a GPU backend explains the CPU fallback", () => {
  const plan = planBackends({ device: "gpu" }, "linux");
  assert.equal(plan.length, 1);
  assert.equal(plan[0].device, "cpu");
  assert.match(plan[0].fallbackReason, /no GPU backend on linux/);
});

// Official kokoro: input_ids = [0, *(vocab[p] for p in phonemes if p in vocab), 0]
const VOCAB = { a: 43, b: 44, " ": 16, "ˈ": 156, "ɪ": 102 };

test("tokenize: official mapping — vocab chars only, framed by pad 0", () => {
  assert.deepEqual(tokenize("ab ˈɪ", VOCAB), [0, 43, 44, 16, 156, 102, 0]);
  assert.deepEqual(tokenize("a?b", VOCAB), [0, 43, 44, 0], "unknown symbols are dropped");
  assert.deepEqual(tokenize("", VOCAB), [0, 0]);
});

test("tokenize: caps at the model's 510-phoneme context", () => {
  const ids = tokenize("a".repeat(600), VOCAB);
  assert.equal(ids.length, 512);
  assert.equal(ids[0], 0);
  assert.equal(ids[511], 0);
});

test("styleRow: official voice row is len(phonemes) - 1 (kokoro-js uses + 1)", () => {
  // 104 input ids = 102 phonemes + 2 pads -> row 101
  assert.equal(styleRow(104), 101);
  assert.equal(styleRow(3), 0); // one phoneme
  assert.equal(styleRow(2), 0); // clamp
  assert.equal(styleRow(600), 509); // clamp to the voice pack's 510 rows
});
