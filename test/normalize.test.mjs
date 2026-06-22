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
    ["2026-06-16", "2026, 06, 16"], // ISO date: separate groups, never "to"
    ["due 2026-06-16 sharp", "due 2026, 06, 16 sharp"],
    ["2010-2020", "2010-2020"], // 4-4 year range left for ai mode, not a date
    ["R&D", "R and D"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(N.deterministic(input), expected, `for "${input}"`);
  }
  assert.equal(N.deterministic("e.g. this"), "for example this");
});

test("deterministic: tilde, ranges, arrows, emoji", () => {
  const cases = [
    ["~5–20%", "about 5 to 20 percent"], // tilde + range + percent (en dash)
    ["~5-20%", "about 5 to 20 percent"], // ASCII hyphen range in percent context
    ["~100 events", "about 100 events"],
    ["A → C", "A to C"],
    ["step 1 -> step 2", "step 1 to step 2"], // space-flanked ASCII arrow
    ["a -> b -> c", "a to b to c"], // chained arrows
    ["queue: -> ->", "queue: to to"], // adjacent arrows both convert
    ["x-->0", "x-->0"], // code: not whitespace-flanked → left intact
    ["a->b", "a->b"], // code: member access → left intact
    ["<!-- -->", "<!-- -->"], // double-dash --> left alone (HTML comment)
    ["loop --> exit", "loop --> exit"], // double-dash arrow not matched
    ["2*3", "2*3"], // lone multiplication preserved (no 2*3→23)
    ["✅ done", "check done"],
    ["build ✅", "build check"],
    ["ship it 🚀🔥", "ship it rocket fire"], // mapped emoji
    ["nice 😀 work 🎈", "nice work"], // unmapped emoji dropped
  ];
  for (const [input, expected] of cases) {
    assert.equal(N.deterministic(input), expected, `for "${input}"`);
  }
});

test("emphasis markers are silent (never read 'asterisk'), even off the Markdown path", () => {
  const cases = [
    ["**bold** and *italic*", "bold and italic"],
    ["*(Source: adopting the critique on the merits.)*", "(Source: adopting the critique on the merits.)"],
    // multi-line Markdown prose spoken from a non-Markdown buffer (no stripMarkdown)
    [
      "**Upgrade over ego.** Adopt a critique **iff the argument is strictly stronger** — never for\nego. **Authority, source, and pressure are not evidence.** That last clause.\n*(Source: the merits.)*",
      "Upgrade over ego. Adopt a critique iff the argument is strictly stronger — never for\nego. Authority, source, and pressure are not evidence. That last clause.\n(Source: the merits.)",
    ],
    ["__bold__ and _under_ emphasis", "bold and under emphasis"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(N.deterministic(input), expected, `for "${input}"`);
    assert.ok(!/\*/.test(N.deterministic(input)), `no asterisk left: "${input}"`);
  }
  // intra-word underscores aren't emphasis, but identifiers ARE split for speech
  assert.equal(N.deterministic("read file_name and snake_case"), "read file name and snake case");
  // lone / spaced operators are not treated as emphasis
  assert.equal(N.deterministic("compute a * b carefully"), "compute a * b carefully");
});

test("splitIdentifiers: camelCase / snake_case / SCREAMING split; brands kept", () => {
  assert.equal(N.splitIdentifiers("getUserName"), "get User Name");
  assert.equal(N.splitIdentifiers("XMLHttpRequest"), "XML Http Request");
  assert.equal(N.splitIdentifiers("MAX_BUFFER_SEC"), "MAX BUFFER SEC");
  assert.equal(N.splitIdentifiers("read file_name now"), "read file name now");
  // plain words, acronyms, and allowlisted brands are untouched
  assert.equal(N.splitIdentifiers("the JSON API in JavaScript on GitHub"), "the JSON API in JavaScript on GitHub");
  // apostrophes and numbers survive
  assert.equal(N.splitIdentifiers("don't use utf8 here"), "don't use utf8 here");
});

test("deterministic code profile: operators expand, prose rules skipped", () => {
  // operators → words
  assert.equal(N.deterministic("if (a == b && c != d)", "code"), "if (a equals b and c not equal d)");
  // identifiers split in code too
  assert.equal(N.deterministic("int maxCount = 0;", "code"), "int max Count = 0;");
  // prose-only rules do NOT fire on code: $ stays a variable, % stays modulo
  assert.equal(N.deterministic("x = $total % 100", "code"), "x = $total % 100");
  // ...but the SAME text in prose profile expands them
  assert.equal(N.deterministic("split 50% off", "prose"), "split 50 percent off");
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
