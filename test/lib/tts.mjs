// Kokoro TTS for tests: the shipped model through src/synth.ts (bundled to
// test/.synth.cjs), i.e. models/kokoro-speak from `npm run prepare-model`.
// KOKORO_DEVICE=cpu|gpu|auto picks where the vocoder runs (default cpu).

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../.synth.cjs");
S.configureModel({ device: process.env.KOKORO_DEVICE || "cpu" });

export function loadTTS() {
  return S.loadModel();
}

/** Decode the 16-bit PCM WAV segments synth emits back to float samples. */
function wavToFloat(wav) {
  const n = (wav.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = wav.readInt16LE(44 + i * 2) / 0x8000;
  return out;
}

/**
 * @param {string} text
 * @param {string} voice
 * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
 */
export async function synthesize(text, voice = "af_heart") {
  const parts = [];
  await S.synthesize(text, { voice, bufferSeconds: 0 }, {
    onSegment: (wav) => parts.push(wavToFloat(wav)),
    shouldCancel: () => false,
  });
  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    samples.set(p, o);
    o += p.length;
  }
  return { samples, sampleRate: 24000 };
}
