// Headless-browser verification of the WASM inference path (no VS Code, no
// <audio> playback). Mirrors what webview/main.ts does up to producing a WAV
// blob, then reports the result on window.__kokoroResult for the test driver.

import { KokoroTTS } from "kokoro-js";

const out = document.getElementById("out")!;
function set(o: Record<string, unknown>) {
  (window as any).__kokoroResult = o;
  out.textContent = JSON.stringify(o, null, 2);
}

(async () => {
  try {
    set({ status: "loading" });
    const t0 = performance.now();
    const tts = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      { dtype: "q8", device: "wasm" }
    );
    const loadMs = Math.round(performance.now() - t0);

    set({ status: "synthesizing", loadMs });
    const tGen = performance.now();
    const audio = await tts.generate(
      "Hello from the headless browser inference test.",
      { voice: "af_heart" }
    );
    const genMs = Math.round(performance.now() - tGen);
    const wavBytes = audio.toWav().byteLength;
    const seconds = audio.audio.length / audio.sampling_rate;

    set({
      status: "ok",
      loadMs,
      genMs,
      seconds: Number(seconds.toFixed(2)),
      sampleRate: audio.sampling_rate,
      wavBytes,
      voices: Object.keys(tts.voices).length,
    });
  } catch (err: any) {
    set({ status: "error", message: err?.message ?? String(err), stack: err?.stack });
  }
})();
