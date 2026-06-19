// Webview = synthesis worker. It loads Kokoro (WASM) and turns text into a WAV,
// then hands the bytes to the extension host, which plays them through the OS
// audio player. No audio plays here — that avoids the webview autoplay-gesture
// restriction entirely.

import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// Local ONNX-Runtime-Web (set by host on <body data-ort-base>), single-threaded
// (webviews aren't cross-origin isolated).
const ortWasm = env.backends?.onnx?.wasm;
if (ortWasm) {
  const ortBase = document.body.dataset.ortBase;
  if (ortBase) ortWasm.wasmPaths = ortBase;
  ortWasm.numThreads = 1;
}

const stateEl = document.getElementById("state")!;
const logEl = document.getElementById("log")!;

function status(state: string, detail?: string) {
  stateEl.textContent = detail ?? state;
  vscode.postMessage({ type: "status", state, detail });
}
function log(line: string) {
  logEl.textContent += line + "\n";
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";
const VOICE = "af_heart";

let ttsPromise: Promise<KokoroTTS> | undefined;
// Monotonic token so a cancelled/superseded synthesis is dropped, not sent.
let generation = 0;

function loadModel(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    status("loading", "Loading model… (first run downloads ~80–90MB)");
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: "wasm",
      progress_callback: (p: any) => {
        if (p.status === "progress" && typeof p.progress === "number") {
          status("loading", `Downloading model: ${Math.round(p.progress)}%`);
        }
      },
    });
  }
  return ttsPromise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function synthesize(text: string) {
  generation++;
  const myGen = generation;
  try {
    const tts = await loadModel();
    if (myGen !== generation) return;

    status("synthesizing", "Synthesizing…");
    const t0 = performance.now();
    const audio = await tts.generate(text, { voice: VOICE });
    if (myGen !== generation) return; // cancelled while synthesizing

    const ms = Math.round(performance.now() - t0);
    const seconds = audio.audio.length / audio.sampling_rate;
    log(
      `synthesized ${seconds.toFixed(2)}s in ${ms}ms ` +
        `(${(seconds / (ms / 1000)).toFixed(1)}x realtime)`
    );

    const b64 = bytesToBase64(new Uint8Array(audio.toWav()));
    status("synthesizing", "Sending to player…");
    vscode.postMessage({ type: "audio", b64 });
  } catch (err: any) {
    if (myGen !== generation) return;
    const message = err?.message ?? String(err);
    log("ERROR: " + message);
    status("error", "Error — see log.");
    vscode.postMessage({ type: "error", text: message });
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type === "synthesize") {
    synthesize(String(msg.text));
  } else if (msg?.type === "cancel") {
    generation++; // drop any in-flight synthesis
    status("idle", "Stopped.");
  }
});

status("idle", "Ready.");
