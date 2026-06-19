// M1 synthesis spike — prove kokoro-js loads the model and produces audio in
// THIS environment, before we wire up any VS Code / webview harness.
//
// Run: npm run spike
// Output: ./out/spike.wav  (open it to confirm it speaks the sentence)

import { writeFile, mkdir } from "node:fs/promises";
import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8"; // q8 ≈ 80–90MB; matches our default quantization
const VOICE = "af_heart";
const TEXT =
  "Hello from Kokoro Speak. This is the M1 synthesis spike running in Node.";

const t0 = Date.now();
console.log(`[spike] loading ${MODEL_ID} (dtype=${DTYPE})…`);

const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
  dtype: DTYPE,
  // Node uses onnxruntime-node ("cpu"); the webview will use "wasm" later.
  device: "cpu",
  progress_callback: (p) => {
    if (p.status === "progress" && p.file?.endsWith(".onnx")) {
      const pct = Math.round((p.progress ?? 0));
      process.stdout.write(`\r[spike] downloading model: ${pct}%   `);
    }
  },
});

console.log(`\n[spike] model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const tGen = Date.now();
const audio = await tts.generate(TEXT, { voice: VOICE });
const genMs = Date.now() - tGen;

const wav = audio.toWav(); // ArrayBuffer of a 16-bit PCM WAV
await mkdir("out", { recursive: true });
await writeFile("out/spike.wav", Buffer.from(wav));

const seconds = audio.audio.length / audio.sampling_rate;
console.log(
  `[spike] generated ${seconds.toFixed(2)}s of audio in ${genMs}ms ` +
    `(${(seconds / (genMs / 1000)).toFixed(1)}x realtime) @ ${audio.sampling_rate}Hz`
);
console.log(`[spike] wrote out/spike.wav (${Buffer.from(wav).length} bytes)`);
console.log(`[spike] available voices: ${Object.keys(tts.voices).length}`);
