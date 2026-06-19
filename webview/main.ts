// Webview = synthesis worker. It loads Kokoro (WASM) and turns text into a WAV,
// then hands the bytes to the extension host, which plays them through the OS
// audio player. No audio plays here — that avoids the webview autoplay-gesture
// restriction entirely.

import { KokoroTTS, TextSplitterStream } from "kokoro-js";
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

// Encode concatenated samples as one 16-bit PCM WAV so a whole buffer plays in a
// single afplay call (each OS-player launch costs ~0.85s, which is the gap
// between separately-played sentences).
function encodeWavPCM16(samples: Float32Array, rate: number): ArrayBuffer {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buf;
}

// Hard cap so an enormous document still bounds memory / time-to-first-audio.
const MAX_BUFFER_SEC = 600;

async function synthesize(
  text: string,
  voice = VOICE,
  speed = 1,
  reqId = 0,
  bufferSeconds = 0
) {
  generation++;
  const myGen = generation;
  try {
    const tts = await loadModel();
    if (myGen !== generation) return;

    // Kokoro has a ~510-token context limit, so we split into sentences (an
    // explicit splitter we close, so the stream terminates). We then buffer the
    // sentences' audio and emit larger concatenated WAVs: bufferSeconds <= 0
    // buffers the whole selection into one gapless clip; a positive value starts
    // sooner at the cost of a brief gap at each segment boundary.
    status("synthesizing", "Synthesizing…");
    const splitter = new TextSplitterStream();
    const stream = tts.stream(splitter, { voice: voice as any, speed });
    splitter.push(text);
    splitter.close();

    let parts: Float32Array[] = [];
    let bufferedSamples = 0;
    let rate = 24000;
    let sentences = 0;
    let segments = 0;
    let emitted = false;

    const limitSec = bufferSeconds > 0 ? bufferSeconds : MAX_BUFFER_SEC;
    const flush = () => {
      if (!bufferedSamples) return;
      const merged = new Float32Array(bufferedSamples);
      let o = 0;
      for (const p of parts) {
        merged.set(p, o);
        o += p.length;
      }
      const b64 = bytesToBase64(new Uint8Array(encodeWavPCM16(merged, rate)));
      vscode.postMessage({ type: "audio", b64, index: segments++, reqId });
      parts = [];
      bufferedSamples = 0;
      emitted = true;
    };

    for await (const chunk of stream) {
      if (myGen !== generation) return; // cancelled
      parts.push(chunk.audio.audio);
      bufferedSamples += chunk.audio.audio.length;
      rate = chunk.audio.sampling_rate;
      sentences++;
      log(`sentence ${sentences}: ${chunk.text.trim().slice(0, 60)}`);
      if (bufferedSamples / rate >= limitSec) {
        flush();
      } else if (!emitted) {
        // Progress while building the first (lead) buffer; once we've emitted,
        // the host owns the "Speaking" status and we must not override it.
        status("synthesizing", `Synthesizing… (${sentences} sentence(s))`);
      }
    }
    if (myGen !== generation) return;
    flush();
    stateEl.textContent = sentences
      ? `Spoke ${sentences} sentence(s).`
      : "Nothing to speak.";
    vscode.postMessage({ type: "audioEnd", count: segments, reqId });
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
    synthesize(String(msg.text), msg.voice, msg.speed, msg.reqId, msg.bufferSeconds);
  } else if (msg?.type === "cancel") {
    generation++; // drop any in-flight synthesis
    status("idle", "Stopped.");
  }
});

status("idle", "Ready.");
