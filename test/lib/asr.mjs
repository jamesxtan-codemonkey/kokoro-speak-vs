// Whisper ASR wrapper for tests — transcribes Kokoro's output back to text so
// we can verify the speech is intelligible. Local, no API key (transformers.js
// + onnxruntime-node). whisper-base.en is a good accuracy/size balance for
// clean synthetic speech.

import { pipeline } from "@huggingface/transformers";
import { resample } from "./audio.mjs";

const MODEL_ID = "Xenova/whisper-base.en";
const WHISPER_RATE = 16000;

let asrPromise;

export function loadASR() {
  if (!asrPromise) {
    asrPromise = pipeline("automatic-speech-recognition", MODEL_ID, {
      dtype: "q8",
      device: "cpu",
    });
  }
  return asrPromise;
}

/**
 * @param {{samples: Float32Array, sampleRate: number}} audio
 * @returns {Promise<string>}
 */
export async function transcribe({ samples, sampleRate }) {
  const asr = await loadASR();
  const audio16k = resample(samples, sampleRate, WHISPER_RATE);
  const out = await asr(audio16k);
  return (out?.text ?? "").trim();
}
