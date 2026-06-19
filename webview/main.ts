// M1 spike webview: load Kokoro (WASM) and play synthesized audio in-browser.
// This is the path the real extension will use — inference in the webview,
// host orchestrates.

import { KokoroTTS } from "kokoro-js";

// VS Code webview bridge (typed loosely; only used for status messages).
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};
const vscode = acquireVsCodeApi();

const stateEl = document.getElementById("state")!;
const logEl = document.getElementById("log")!;

function setState(text: string) {
  stateEl.textContent = text;
  vscode.postMessage({ type: "status", text });
}
function log(line: string) {
  logEl.textContent += line + "\n";
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";
const VOICE = "af_heart";

let ttsPromise: Promise<KokoroTTS> | undefined;

function loadModel(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    setState("Loading model… (first run downloads ~80–90MB)");
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: "wasm",
      progress_callback: (p: any) => {
        if (p.status === "progress" && typeof p.progress === "number") {
          setState(`Downloading ${p.file ?? "model"}: ${Math.round(p.progress)}%`);
        }
      },
    });
  }
  return ttsPromise;
}

async function speak(text: string) {
  try {
    const t0 = performance.now();
    const tts = await loadModel();
    log(`model ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

    setState("Synthesizing…");
    const tGen = performance.now();
    const audio = await tts.generate(text, { voice: VOICE });
    const genMs = Math.round(performance.now() - tGen);
    const seconds = audio.audio.length / audio.sampling_rate;
    log(
      `generated ${seconds.toFixed(2)}s in ${genMs}ms ` +
        `(${(seconds / (genMs / 1000)).toFixed(1)}x realtime)`
    );

    const blob = new Blob([audio.toWav()], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    el.onended = () => URL.revokeObjectURL(url);
    setState("Speaking…");
    await el.play();
    setState("Done. Run again to replay.");
  } catch (err: any) {
    const text = err?.message ?? String(err);
    log("ERROR: " + text);
    setState("Error — see log.");
    vscode.postMessage({ type: "error", text });
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "speak") {
    speak(String(msg.text));
  }
});

setState("Webview ready.");
