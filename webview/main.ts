// M2 webview: load Kokoro (WASM), synthesize text from the host, and play it
// with pause/resume/stop. Reports playback state back to the host so the status
// bar stays in sync. Inference in the webview, host orchestrates.

import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// Serve the ONNX-Runtime-Web wasm/loader from the extension (set by the host on
// <body data-ort-base>), not the jsdelivr CDN the webview CSP blocks. Single
// thread: webviews aren't cross-origin isolated, so SharedArrayBuffer/worker
// threading is unavailable anyway.
const ortWasm = env.backends?.onnx?.wasm;
if (ortWasm) {
  const ortBase = document.body.dataset.ortBase;
  if (ortBase) ortWasm.wasmPaths = ortBase;
  ortWasm.numThreads = 1;
}

const stateEl = document.getElementById("state")!;
const logEl = document.getElementById("log")!;
const hintEl = document.getElementById("hint")!;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;

type State =
  | "idle"
  | "loading"
  | "synthesizing"
  | "speaking"
  | "paused"
  | "blocked"
  | "done"
  | "error";

function setState(state: State, detail?: string) {
  stateEl.textContent = detail ?? state;
  // Play is offered when audio is queued but blocked, or paused.
  playBtn.disabled = !(state === "blocked" || state === "paused");
  pauseBtn.disabled = !(state === "speaking" || state === "paused");
  pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
  stopBtn.disabled = !(
    state === "speaking" ||
    state === "paused" ||
    state === "blocked" ||
    state === "synthesizing"
  );
  hintEl.textContent =
    state === "blocked"
      ? "VS Code blocks audio until you click in this panel. Click Play once — after that, Speak plays automatically."
      : "";
  vscode.postMessage({ type: "state", state, detail });
}
function log(line: string) {
  logEl.textContent += line + "\n";
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";
const VOICE = "af_heart";

let ttsPromise: Promise<KokoroTTS> | undefined;
let current: HTMLAudioElement | undefined;
// Audio synthesized and ready, but waiting for a user gesture to start.
let pending: HTMLAudioElement | undefined;
// Monotonic token so a stale synthesis can't start playing after Stop/replace.
let generation = 0;

function loadModel(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    setState("loading", "Loading model… (first run downloads ~80–90MB)");
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      device: "wasm",
      progress_callback: (p: any) => {
        if (p.status === "progress" && typeof p.progress === "number") {
          setState("loading", `Downloading model: ${Math.round(p.progress)}%`);
        }
      },
    });
  }
  return ttsPromise;
}

function stopPlayback() {
  pending = undefined;
  if (current) {
    current.pause();
    current.src = "";
    if (current.dataset.url) URL.revokeObjectURL(current.dataset.url);
    current = undefined;
  }
}

async function speak(text: string) {
  generation++;
  const myGen = generation;
  stopPlayback();
  try {
    const tts = await loadModel();
    if (myGen !== generation) return; // superseded while loading

    setState("synthesizing", "Synthesizing…");
    const tGen = performance.now();
    const audio = await tts.generate(text, { voice: VOICE });
    if (myGen !== generation) return; // superseded while synthesizing

    const genMs = Math.round(performance.now() - tGen);
    const seconds = audio.audio.length / audio.sampling_rate;
    log(
      `synthesized ${seconds.toFixed(2)}s in ${genMs}ms ` +
        `(${(seconds / (genMs / 1000)).toFixed(1)}x realtime)`
    );

    const url = URL.createObjectURL(
      new Blob([audio.toWav()], { type: "audio/wav" })
    );
    const el = new Audio(url);
    el.dataset.url = url;
    el.onended = () => {
      if (current === el) {
        stopPlayback();
        setState("done", "Done.");
      }
    };
    current = el;
    await startPlayback(el);
  } catch (err: any) {
    if (myGen !== generation) return;
    const message = err?.message ?? String(err);
    log("ERROR: " + message);
    setState("error", "Error — see log.");
    vscode.postMessage({ type: "error", text: message });
  }
}

// Try to play. If the browser blocks it (no user gesture yet in this webview),
// queue it and surface the Play button instead of erroring.
async function startPlayback(el: HTMLAudioElement) {
  setState("speaking");
  try {
    await el.play();
    pending = undefined;
  } catch (err: any) {
    if (err?.name === "NotAllowedError") {
      pending = el;
      setState("blocked", "Audio ready — click Play.");
    } else {
      throw err;
    }
  }
}

function togglePause() {
  if (!current) return;
  if (current.paused) {
    current.play();
    setState("speaking");
  } else {
    current.pause();
    setState("paused", "Paused.");
  }
}

function stop() {
  generation++; // cancel any in-flight synthesis
  pending = undefined;
  stopPlayback();
  setState("idle", "Stopped.");
}

// User gesture: start queued audio (also grants this webview audio activation
// for the rest of its lifetime, so later Speak calls auto-play), or resume.
playBtn.addEventListener("click", () => {
  if (pending) {
    startPlayback(pending);
  } else if (current?.paused) {
    togglePause();
  }
});
pauseBtn.addEventListener("click", togglePause);
stopBtn.addEventListener("click", stop);

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case "speak":
      speak(String(msg.text));
      break;
    case "pause":
      togglePause();
      break;
    case "stop":
      stop();
      break;
  }
});

setState("idle", "Webview ready.");
