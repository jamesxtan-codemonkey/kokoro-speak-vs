// Tests for chunkText — the splitter that keeps each Kokoro generation under the
// model's ~512-token cap (over-long generations get truncated, dropping the
// tail) — and for backend planning (GPU/CPU, weight precision). Pure functions;
// bundled to test/.synth.cjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chunkText, planBackends, resolvePrecision, gpuDevice } = require("./.synth.cjs");

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

// Which precisions are "on disk": the packaged VSIX bundles only q8.
const ALL_LOCAL = () => true;
const ONLY_Q8 = (dtype) => dtype === "q8";

test("gpuDevice: DirectML on Windows, none elsewhere", () => {
  assert.equal(gpuDevice("win32"), "dml");
  assert.equal(gpuDevice("darwin"), undefined);
  assert.equal(gpuDevice("linux"), undefined);
});

test("resolvePrecision auto: q8 on GPU, fp32 on Windows x64 CPU, q8 on other CPUs", () => {
  assert.equal(resolvePrecision("auto", "dml", "win32", "x64"), "q8");
  assert.equal(resolvePrecision("auto", "cpu", "win32", "x64"), "fp32");
  assert.equal(resolvePrecision("auto", "cpu", "win32", "arm64"), "q8");
  assert.equal(resolvePrecision("auto", "cpu", "darwin", "arm64"), "q8");
  assert.equal(resolvePrecision("auto", "cpu", "linux", "x64"), "q8");
  // explicit precision always wins
  assert.equal(resolvePrecision("fp16", "dml", "win32", "x64"), "fp16");
  assert.equal(resolvePrecision("q8", "cpu", "win32", "x64"), "q8");
});

test("planBackends: Windows auto tries DirectML first, then CPU", () => {
  const plan = planBackends({ device: "auto", precision: "auto" }, "win32", "x64", ALL_LOCAL);
  assert.deepEqual(plan, [
    { device: "dml", dtype: "q8" },
    { device: "cpu", dtype: "fp32" },
  ]);
});

test("planBackends: device cpu skips the GPU", () => {
  const plan = planBackends({ device: "cpu", precision: "auto" }, "win32", "x64", ALL_LOCAL);
  assert.deepEqual(plan, [{ device: "cpu", dtype: "fp32" }]);
});

test("planBackends: macOS auto stays on CPU q8 (unchanged behavior)", () => {
  const plan = planBackends({ device: "auto", precision: "auto" }, "darwin", "arm64", ONLY_Q8);
  assert.deepEqual(plan, [{ device: "cpu", dtype: "q8" }]);
  assert.equal(plan[0].fallbackReason, undefined, "auto on a GPU-less platform is not a fallback");
});

test("planBackends: device gpu without a GPU backend explains the CPU fallback", () => {
  const plan = planBackends({ device: "gpu", precision: "auto" }, "linux", "x64", ONLY_Q8);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].device, "cpu");
  assert.match(plan[0].fallbackReason, /no GPU backend on linux/);
});

test("planBackends: Windows CPU without fp32 on disk uses bundled q8 and offers fp32", () => {
  const plan = planBackends({ device: "cpu", precision: "auto" }, "win32", "x64", ONLY_Q8);
  assert.deepEqual(plan, [{ device: "cpu", dtype: "q8", upgrade: "fp32" }]);
});

test("planBackends: the GPU entry needs no upgrade (q8 is its best precision)", () => {
  const plan = planBackends({ device: "auto", precision: "auto" }, "win32", "x64", ONLY_Q8);
  assert.deepEqual(plan[0], { device: "dml", dtype: "q8" });
  assert.deepEqual(plan[1], { device: "cpu", dtype: "q8", upgrade: "fp32" });
});

test("planBackends: an explicit precision is used as-is (downloaded if needed)", () => {
  const plan = planBackends({ device: "cpu", precision: "fp32" }, "win32", "x64", ONLY_Q8);
  assert.deepEqual(plan, [{ device: "cpu", dtype: "fp32" }]);
});
