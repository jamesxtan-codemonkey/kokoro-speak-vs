// Partial end-to-end round-trip: text → Kokoro TTS → audio → Whisper ASR → text,
// then assert the heard transcript matches the input at the word level. This
// proves the synthesized speech is actually intelligible, not just non-empty.
//
// Verifier = whisper-base.en (local, no API key). Residual mismatches on common
// English therefore indicate a real TTS problem. Proper nouns are a known ASR
// limitation, covered separately below.

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { loadTTS, synthesize } from "./lib/tts.mjs";
import { loadASR, transcribe } from "./lib/asr.mjs";
import { wordMatchRatio } from "./lib/textmatch.mjs";

// Ordinary-vocabulary sentences (no digits/symbols/brand names) so this isolates
// TTS intelligibility, not the normalizer and not ASR's proper-noun weakness.
const CASES = [
  "The quick brown fox jumps over the lazy dog.",
  "Please read the selected paragraph aloud at a normal pace.",
  "Open weights make local speech synthesis possible.",
  "She sells seashells by the seashore on a sunny morning.",
];

const THRESHOLD = 0.8; // ≥80% of expected words must be heard back

function report(input, heard, m) {
  console.log(
    `\n  input: ${input}` +
      `\n  heard: ${heard}` +
      `\n  match: ${(m.ratio * 100).toFixed(0)}% (${m.matched}/${m.total})` +
      (m.missing.length ? `  missing: [${m.missing.join(", ")}]` : "")
  );
}

before(async () => {
  // Warm both models once so per-case timing reflects inference, not download.
  await Promise.all([loadTTS(), loadASR()]);
});

for (const input of CASES) {
  test(`round-trip: "${input}"`, async () => {
    const audio = await synthesize(input);
    assert.ok(audio.samples.length > 0, "synthesis produced no audio");

    const heard = await transcribe(audio);
    const m = wordMatchRatio(input, heard);
    report(input, heard, m);

    assert.ok(
      m.ratio >= THRESHOLD,
      `word match ${(m.ratio * 100).toFixed(0)}% < ${THRESHOLD * 100}% — heard "${heard}"`
    );
  });
}

// Documents a real finding from this round-trip: Kokoro pronounces the brand
// name correctly, but whisper-base.en AND whisper-small.en both transcribe
// "Kokoro" as "Cockro"/"Cocro". This is an ASR limitation on an out-of-vocab
// proper noun, NOT a synthesis defect — so we assert the ordinary words survive
// the round-trip while accepting that the brand name does not.
test("proper nouns: ordinary words survive even when ASR mangles the brand name", async () => {
  const input = "Kokoro Speak reads text aloud inside your editor.";
  const ordinary = "reads text aloud inside your editor";

  const heard = await transcribe(await synthesize(input));
  const m = wordMatchRatio(ordinary, heard);
  report(input, heard, m);

  assert.equal(
    m.ratio,
    1,
    `expected every ordinary word to be heard back; missing [${m.missing.join(", ")}] in "${heard}"`
  );
});
