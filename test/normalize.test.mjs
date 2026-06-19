// Deterministic normalization tests — offline, no model, no network.
// The module is bundled to test/.normalize.cjs by the `test` npm script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const N = require("./.normalize.cjs");

test("deterministic: currency, percent, version, quarter, abbreviations", () => {
  const cases = [
    ["$10B", "10 billion dollars"],
    ["$3.5M", "3.5 million dollars"],
    ["$10", "10 dollars"],
    ["~50%", "about 50 percent"],
    ["50%", "50 percent"],
    ["v1.2.3", "version 1 point 2 point 3"],
    ["Q4 2025", "fourth quarter 2025"],
    ["345k–400k", "345 thousand to 400 thousand"], // en dash
    ["R&D", "R and D"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(N.deterministic(input), expected, `for "${input}"`);
  }
  assert.equal(N.deterministic("e.g. this"), "for example this");
});

test("deterministic: tilde, ranges, arrows, asterisks, emoji", () => {
  const cases = [
    ["~5–20%", "about 5 to 20 percent"], // tilde + range + percent (en dash)
    ["~100 events", "about 100 events"],
    ["A → C", "A to C"],
    ["step 1 -> step 2", "step 1 to step 2"],
    ["**bold** and *italic*", "bold and italic"], // no "asterisk"
    ["✅ done", "check done"],
    ["build ✅", "build check"],
    ["ship it 🚀🔥", "ship it rocket fire"], // mapped emoji
    ["nice 😀 work 🎈", "nice work"], // unmapped emoji dropped
  ];
  for (const [input, expected] of cases) {
    assert.equal(N.deterministic(input), expected, `for "${input}"`);
  }
});

test("spellOut: acronyms read letter-by-letter (whole words only)", () => {
  assert.equal(
    N.applySpellOut("the API and LFP program, not APItude", ["API", "LFP"]),
    "the A P I and L F P program, not APItude"
  );
  assert.equal(N.applySpellOut("plain text", []), "plain text");
});

test("gate: hasCandidates", () => {
  assert.equal(N.hasCandidates("just plain words here"), false);
  assert.equal(N.hasCandidates("I have 5 apples"), true);
  assert.equal(N.hasCandidates("costs $10"), true);
  assert.equal(N.hasCandidates("see e.g. this"), true);
});

test("user replacements (literal + regex) apply", () => {
  const reps = [
    { from: "K8s", to: "Kubernetes" },
    { pattern: "\\bWIP\\b", replacement: "work in progress", flags: "g" },
  ];
  assert.equal(
    N.applyReplacements("K8s is WIP", reps),
    "Kubernetes is work in progress"
  );
});

test("normalize: off mode returns input unchanged", async () => {
  const out = await N.normalize("$10B", baseOpts({ mode: "off" }));
  assert.equal(out, "$10B");
});

test("normalize: deterministic mode applies replacements then built-ins", async () => {
  const out = await N.normalize(
    "K8s costs $10B",
    baseOpts({ mode: "deterministic", replacements: [{ from: "K8s", to: "Kubernetes" }] })
  );
  assert.equal(out, "Kubernetes costs 10 billion dollars");
});

test("normalize: ai mode with no backend falls back to deterministic", async () => {
  // backend api + no apiKey ⇒ no backend resolves ⇒ deterministic fallback
  const out = await N.normalize(
    "$10B",
    baseOpts({ mode: "ai", backend: "api", apiKey: undefined })
  );
  assert.equal(out, "10 billion dollars");
});

function baseOpts(over = {}) {
  return {
    mode: "deterministic",
    rules: N.SEED_RULES,
    replacements: [],
    backend: "api",
    command: "",
    model: "claude-haiku-4-5",
    apiKey: undefined,
    timeoutMs: 8000,
    ...over,
  };
}
