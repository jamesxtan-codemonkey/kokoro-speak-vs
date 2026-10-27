// The Kokoro model in onnxruntime-web: frontend (text → durations, pitch,
// features) and decoder (features → 24 kHz audio), both on one backend.
// kokoro-js supplies text cleanup and the espeak phonemizer; its generate()
// hands phoneme ids to generate_from_ids(), where our model takes over (as in
// src/synth.ts for the VS Code extension).
//
// Both halves share a backend because a WASM frontend next to a WebGPU decoder
// slowed down ~6x after a few sentences in testing. The decoder computes in
// fp32 (tools/convert/upcast_decoder.py): in fp16 on WebGPU some words came
// out choppy.

import * as ort from "onnxruntime-web/webgpu";
import { KokoroTTS } from "kokoro-js";
import { SAMPLE_RATE, tokenize, voiceStyle } from "../../../src/core/model";
import type { Device } from "../settings";

ort.env.wasm.wasmPaths = "/ort/";
ort.env.logLevel = "error";

export type Backend = "webgpu" | "wasm";

export interface Engine {
  backend: Backend;
  generate(text: string, voice: string, speed: number): Promise<Float32Array>;
  release(): Promise<void>;
}

export const backendLabel = (b: Backend) => (b === "webgpu" ? "GPU (WebGPU)" : "CPU (WASM)");

const packs = new Map<string, Promise<Float32Array>>();
function voicePack(voice: string): Promise<Float32Array> {
  let p = packs.get(voice);
  if (!p) {
    p = fetch(`/voices/${voice}.bin`)
      .then((r) => r.arrayBuffer())
      .then((b) => new Float32Array(b));
    packs.set(voice, p);
  }
  return p;
}

let vocab: Promise<Record<string, number>> | undefined;

async function loadEngine(backend: Backend): Promise<Engine> {
  vocab ??= fetch("/models/config.json")
    .then((r) => r.json())
    .then((c) => c.vocab);
  const ids2vocab = await vocab;
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: [backend] };
  const frontend = await ort.InferenceSession.create("/models/frontend.onnx", opts);
  let decoder: ort.InferenceSession;
  try {
    decoder = await ort.InferenceSession.create("/models/decoder.onnx", opts);
  } catch (e) {
    await frontend.release();
    throw e;
  }

  const tts = new KokoroTTS(null as any, ((phonemes: string) => ({ input_ids: tokenize(phonemes, ids2vocab) })) as any);
  (tts as any).generate_from_ids = async (ids: number[], o: { voice: string; speed?: number }) => {
    const style = new ort.Tensor("float32", voiceStyle(await voicePack(o.voice), ids.length), [1, 256]);
    const f = await frontend.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
      style,
      speed: new ort.Tensor("float32", Float32Array.of(o.speed ?? 1), [1]),
    });
    const d = await decoder.run({ asr: f.asr, F0_pred: f.F0_pred, N_pred: f.N_pred, style });
    return { audio: d.waveform.data as Float32Array, sampling_rate: SAMPLE_RATE };
  };

  const engine: Engine = {
    backend,
    generate: async (text, voice, speed) => (await tts.generate(text, { voice: voice as any, speed })).audio as Float32Array,
    release: async () => {
      await frontend.release();
      await decoder.release();
    },
  };
  // A GPU can accept the model and still fail at run time, so prove it with a
  // short line; this also compiles its shaders before the first real sentence.
  try {
    await engine.generate("Ready.", "af_heart", 1);
  } catch (e) {
    await engine.release();
    throw e;
  }
  return engine;
}

/** The model on the preferred backend, falling back to WASM. `note` says why
 *  it isn't on the GPU, when the user asked for the GPU. */
export async function loadPreferred(device: Device): Promise<{ engine: Engine; note?: string }> {
  if (device !== "wasm") {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
    if (adapter) {
      try {
        return { engine: await loadEngine("webgpu") };
      } catch (e) {
        console.warn("[kokoro] WebGPU failed, using WASM:", e);
        if (device === "webgpu") return { engine: await loadEngine("wasm"), note: `GPU unavailable (${errText(e)}); using CPU.` };
      }
    } else if (device === "webgpu") {
      return { engine: await loadEngine("wasm"), note: "This browser has no WebGPU adapter; using CPU." };
    }
  }
  return { engine: await loadEngine("wasm") };
}

export { loadEngine };

export function errText(e: unknown): string {
  return String((e as any)?.message ?? e).split("\n")[0].slice(0, 160);
}
