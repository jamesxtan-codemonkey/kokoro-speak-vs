// Kokoro TTS wrapper for tests (Node / onnxruntime-node). Defaults to device
// "cpu" + q8; set KOKORO_DEVICE / KOKORO_DTYPE to verify another backend, e.g.
// KOKORO_DEVICE=dml (Windows GPU via DirectML).

import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEVICE = process.env.KOKORO_DEVICE || "cpu";
const DTYPE = process.env.KOKORO_DTYPE || "q8";

let ttsPromise;

export function loadTTS() {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: DEVICE,
    });
  }
  return ttsPromise;
}

/**
 * @param {string} text
 * @param {string} voice
 * @returns {Promise<{samples: Float32Array, sampleRate: number}>}
 */
export async function synthesize(text, voice = "af_heart") {
  const tts = await loadTTS();
  const audio = await tts.generate(text, { voice });
  return { samples: audio.audio, sampleRate: audio.sampling_rate };
}
