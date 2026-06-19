// Kokoro TTS wrapper for tests (Node / onnxruntime-node, device "cpu").

import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";

let ttsPromise;

export function loadTTS() {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: "cpu",
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
