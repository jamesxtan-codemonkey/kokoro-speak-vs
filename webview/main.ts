// M2 webview: load Kokoro (WASM), synthesize text from the host, and play it
// with pause/resume/stop. Reports playback state back to the host so the status
// bar stays in sync. Inference in the webview, host orchestrates.

import { KokoroTTS } from "kokoro-js";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const stateEl = document.getElementById("state")!;
const logEl = document.getElementById("log")!;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;

type State =
  | "idle"
  | "loading"
  | "synthesizing"
  | "speaking"
  | "paused"
  | "done"
  | "error";

function setState(state: State, detail?: string) {
  stateEl.textContent = detail ?? state;
  pauseBtn.disabled = !(state === "speaking" || state === "paused");
  pauseBtn.textContent = state === "paused" ? "Resume" : "Pause";
  stopBtn.disabled = !(
    state === "speaking" ||
    state === "paused" ||
    state === "synthesizing"
  );
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
    setState("speaking");
    await el.play();
  } catch (err: any) {
    if (myGen !== generation) return;
    const message = err?.message ?? String(err);
    log("ERROR: " + message);
    setState("error", "Error — see log.");
    vscode.postMessage({ type: "error", text: message });
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
  stopPlayback();
  setState("idle", "Stopped.");
}

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
