// Deterministic normalization tests — offline, no model, no network.
// The module is bundled to test/.normalize.cjs by the `test` npm script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  // intra-word underscores (identifiers) survive
  assert.equal(N.deterministic("read file_name and snake_case"), "read file_name and snake_case");
  // lone / spaced operators are not treated as emphasis
  assert.equal(N.deterministic("compute a * b carefully"), "compute a * b carefully");
});

test("spellOut: acronyms read letter-by-letter (whole words only)", () => {
  assert.equal(
    N.applySpellOut("the API and LFP program, not APItude", ["API", "LFP"]),
    "the A-P-I and L-F-P program, not APItude"
  );
  assert.equal(N.applySpellOut("plain text", []), "plain text");
});

test("spellOut: the phonemizer reads each letter as its name, A included", async () => {
  const { phonemize } = await import("phonemizer");
  const ipa = async (t) => (await phonemize(N.applySpellOut(t, ["AWS", "API"]), "en-us")).join(" ");
  // "eɪ" is the letter A; spaced letters gave "ɐ" (the article "a").
  assert.match(await ipa("We run on AWS today."), /ˈeɪdˈʌbəljˌuːˈɛs/);
  assert.match(await ipa("the API key"), /ˈeɪpˈiː/);
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

// Windows: npm installs claude/codex as .cmd shims, which Node won't spawn
// without a shell. A fake shim in a dir with a space checks quoting, that the
// empty --allowed-tools value survives, and that the prompt arrives on stdin.
const winOnly = { skip: process.platform !== "win32" && "Windows-only" };

test("cli backend runs a Windows .cmd shim (quoted path, args, stdin)", winOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kokoro cli "));
  try {
    const shim = join(dir, "fake-claude.cmd");
    writeFileSync(
      shim,
      [
        "@echo off",
        'echo %* > "%~dp0args.txt"',
        'more > "%~dp0stdin.txt"',
        'echo {"result":"spoken text"}',
      ].join("\r\n")
    );
    const out = await N.callBackend("SYSTEM", "USER TEXT", {
      backend: "cli",
      command: shim,
      model: "",
      timeoutMs: 15000,
    });
    assert.equal(out, "spoken text");
    const args = readFileSync(join(dir, "args.txt"), "utf8").trim();
    assert.equal(args, '"-p" "--output-format" "json" "--allowed-tools" ""');
    assert.match(readFileSync(join(dir, "stdin.txt"), "utf8"), /SYSTEM[\s\S]*USER TEXT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli backend timeout kills a hung Windows .cmd shim", winOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kokoro cli "));
  try {
    const shim = join(dir, "hang.cmd");
    writeFileSync(shim, "@echo off\r\nping -n 30 127.0.0.1 >nul\r\n");
    const t0 = Date.now();
    const out = await N.callBackend("s", "u", {
      backend: "cli",
      command: shim,
      model: "",
      timeoutMs: 1000,
    });
    assert.equal(out, null);
    assert.ok(Date.now() - t0 < 5000, "timeout must resolve promptly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
