// Host-side Kokoro synthesis. Runs in the extension host — no webview, no CSP,
// no autoplay. Streams sentences and emits concatenated WAV segments. Kept free
// of `vscode` imports so it can be tested in plain Node.
//
// The model is the official Kokoro-82M v1.0 (hexgrad), converted by
// tools/convert/convert.py into two ONNX files bundled in models/kokoro-speak
// (provenance + validation in its manifest.json):
//   frontend.onnx  phoneme ids -> durations, pitch, features    fp32, always CPU
//   decoder.onnx   features -> 24 kHz waveform (the vocoder)    fp16, GPU or CPU
// The split exists for DirectML: its LSTM kernel re-plans for every new
// sentence length (~1.8 s each), while the vocoder's convolutions are fast. So
// the LSTMs (frontend, ~0.1 s on CPU) stay on the CPU and the vocoder goes to
// the GPU: ~17x realtime end to end (vs ~4x on CPU), unquantized. kokoro-js is used only for its
// phonemizer (text -> IPA) and its voice files (identical to the official ones).

import * as fs from "fs";
import * as path from "path";
import { chunkText } from "./core/chunk";
import { SAMPLE_RATE, tokenize, voiceStyle as styleFromPack } from "./core/model";

export { chunkText } from "./core/chunk";
export { tokenize, styleRow } from "./core/model";

// kokoro-js is ESM-only. The extension host bundle is CommonJS, and `require()`
// of an ESM package throws ERR_REQUIRE_ESM on the Node that ships inside VS Code.
// Load it via a real dynamic import() that esbuild won't rewrite to require()
// (wrapping in `new Function` hides it from the bundler).
const importKokoro: () => Promise<any> = new Function(
  "return import('kokoro-js')"
) as any;

let kokoroMod: any;
async function kokoro(): Promise<any> {
  if (!kokoroMod) kokoroMod = await importKokoro();
  return kokoroMod;
}

// onnxruntime-node is a native addon with a CommonJS entry; load it on first use.
let ortMod: any;
function ort(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (!ortMod) ortMod = require("onnxruntime-node");
  return ortMod;
}

// This file is bundled to dist/*.js (or test/*.cjs): the extension root is one
// level up.
export const MODEL_DIR = path.join(__dirname, "..", "models", "kokoro-speak");
const VOICES_DIR = path.join(__dirname, "..", "node_modules", "kokoro-js", "voices");
const MAX_BUFFER_SEC = 600;

/** "auto" = the platform GPU if there is one (DirectML on Windows), else CPU. */
export type DevicePref = "auto" | "gpu" | "cpu";

export interface ModelPrefs {
  device: DevicePref;
}

/** Where the vocoder runs (the frontend always runs on the CPU). */
export interface Backend {
  /** onnxruntime execution provider: "dml" | "cpu". */
  device: string;
  /** Why we're not on the preferred GPU, if we fell back. */
  fallbackReason?: string;
}

/** GPU execution provider this platform's onnxruntime-node ships, if any.
 *  Windows bundles DirectML (any D3D12 GPU: NVIDIA, AMD, Intel). */
export function gpuDevice(platform: string = process.platform): string | undefined {
  return platform === "win32" ? "dml" : undefined;
}

/** Ordered backends to try for the vocoder: the GPU first (if wanted and
 *  present), then CPU. */
export function planBackends(prefs: ModelPrefs, platform: string = process.platform): Backend[] {
  const plan: Backend[] = [];
  const gpu = gpuDevice(platform);
  if (prefs.device !== "cpu" && gpu) plan.push({ device: gpu });
  const cpu: Backend = { device: "cpu" };
  if (prefs.device === "gpu" && !gpu) cpu.fallbackReason = `no GPU backend on ${platform}`;
  plan.push(cpu);
  return plan;
}

export function describeBackend(b: Backend): string {
  return b.device === "dml" ? "GPU (DirectML)" : b.device === "cpu" ? "CPU" : b.device;
}

const voiceCache = new Map<string, Float32Array>();
function voiceStyle(voice: string, numInputIds: number): Float32Array {
  let pack = voiceCache.get(voice);
  if (!pack) {
    const buf = fs.readFileSync(path.join(VOICES_DIR, `${voice}.bin`));
    pack = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    voiceCache.set(voice, pack);
  }
  return styleFromPack(pack, numInputIds);
}

/** A loaded model: CPU frontend + vocoder on `backend`. `tts` is a kokoro-js
 *  KokoroTTS shell whose generate() phonemizes and then calls our model. */
interface Engine {
  frontend: any;
  decoder: any;
  vocab: Record<string, number>;
  backend: Backend;
  tts: { generate(text: string, o: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }> };
}

let prefs: ModelPrefs = { device: "auto" };
let loadedPromise: Promise<Engine> | undefined;
let backend: Backend | undefined;

/** Set the device. A change drops the loaded model; the next loadModel()
 *  reloads it on the new backend. */
export function configureModel(next: ModelPrefs): void {
  if (next.device === prefs.device) return;
  prefs = { ...next };
  loadedPromise = undefined;
  backend = undefined;
}

/** The backend the current model runs on (undefined until loaded). */
export function currentBackend(): Backend | undefined {
  return backend;
}

function errText(e: unknown): string {
  return String((e as any)?.message ?? e).split("\n")[0].slice(0, 200);
}

function session(file: string, device: string): Promise<any> {
  return ort().InferenceSession.create(path.join(MODEL_DIR, file), {
    executionProviders: [device],
    logSeverityLevel: 3, // errors only (DirectML logs node-placement warnings)
  });
}

async function infer(e: Engine, ids: number[], voice: string, speed: number): Promise<Float32Array> {
  const O = ort();
  const style = new O.Tensor("float32", voiceStyle(voice, ids.length), [1, 256]);
  const f = await e.frontend.run({
    input_ids: new O.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
    style,
    speed: new O.Tensor("float32", Float32Array.of(speed), [1]),
  });
  const d = await e.decoder.run({ asr: f.asr, F0_pred: f.F0_pred, N_pred: f.N_pred, style });
  return d.waveform.data as Float32Array;
}

/** Load the model with the vocoder on `b`, reusing an existing frontend. */
async function loadOn(b: Backend, reuse?: Engine): Promise<Engine> {
  if (!fs.existsSync(path.join(MODEL_DIR, "decoder.onnx"))) {
    throw new Error(
      `Kokoro model not found in ${MODEL_DIR}. Run \`npm run prepare-model\` ` +
        "(converts the official weights; packaged builds include it)."
    );
  }
  const vocab: Record<string, number> =
    reuse?.vocab ?? JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "config.json"), "utf8")).vocab;
  const frontend = reuse?.frontend ?? (await session("frontend.onnx", "cpu"));
  const decoder = await session("decoder.onnx", b.device);
  const e = { frontend, decoder, vocab, backend: b } as Engine;
  // kokoro-js does text normalization + espeak phonemization in generate(),
  // then hands its tokenizer's output to generate_from_ids(). Swap in the
  // official tokenizer / style row / our two-part model at those two seams.
  const { KokoroTTS } = await kokoro();
  const tts = new KokoroTTS(null, (phonemes: string) => ({ input_ids: tokenize(phonemes, vocab) }));
  tts.generate_from_ids = async (ids: number[], o: { voice: string; speed: number }) => ({
    audio: await infer(e, ids, o.voice, o.speed ?? 1),
    sampling_rate: SAMPLE_RATE,
  });
  e.tts = tts;
  // A GPU can accept the model and still fail at run time (driver, unsupported
  // op), so prove it with one short line. This also warms its kernels up.
  if (b.device !== "cpu") await tts.generate("Ready.", { voice: "af_heart", speed: 1 });
  return e;
}

async function loadWithFallback(plan: Backend[], reuse?: Engine): Promise<Engine> {
  let lastErr: unknown;
  let reason: string | undefined;
  for (const b of plan) {
    try {
      return await loadOn({ ...b, fallbackReason: b.fallbackReason ?? reason }, reuse);
    } catch (e) {
      lastErr = e;
      reason = `${b.device} failed: ${errText(e)}`;
      console.warn(`[kokoro-speak] ${reason}; trying the next backend`);
    }
  }
  throw lastErr;
}

/** Install `p` as the current load. Publishes its backend once loaded, unless a
 *  newer load replaced it; a failure isn't cached, so the next call retries. */
function track(p: Promise<Engine>): Promise<Engine> {
  loadedPromise = p;
  p.then(
    (l) => {
      if (loadedPromise === p) backend = l.backend;
    },
    () => {
      if (loadedPromise === p) loadedPromise = undefined;
    }
  );
  return p;
}

function load(): Promise<Engine> {
  return loadedPromise ?? track(loadWithFallback(planBackends(prefs)));
}

/** Load (or reuse) the model. Resolves once it can synthesize. */
export function loadModel(): Promise<unknown> {
  return load();
}

/** The GPU failed mid-run (e.g. device lost after sleep): vocoder -> CPU. */
function fallBackToCpu(failed: Engine, err: unknown): Promise<Engine> {
  const reason = `${failed.backend.device} failed: ${errText(err)}`;
  console.warn(`[kokoro-speak] ${reason}; switching to CPU`);
  return track(loadWithFallback([{ device: "cpu", fallbackReason: reason }], failed));
}

/** Encode mono Float32 samples as a 16-bit PCM WAV Buffer. */
export function encodeWavPCM16(samples: Float32Array, rate: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, o);
    o += 2;
  }
  return buf;
}

export interface SynthCallbacks {
  /** Called with each concatenated WAV segment as it's ready. */
  onSegment: (wav: Buffer, durationSec: number) => void;
  /** Sentence-count progress while building the first segment. */
  onProgress?: (sentences: number) => void;
  /** Return true to stop (checked between sentences). */
  shouldCancel: () => boolean;
}

export interface SynthOptions {
  voice?: string;
  speed?: number;
  /** <=0 buffers the whole text into one gapless segment. */
  bufferSeconds?: number;
}

/** Synthesize `text` into concatenated WAV segments. Returns the chunk count. */
export async function synthesize(
  text: string,
  { voice = "af_heart", speed = 1, bufferSeconds = 0 }: SynthOptions,
  cb: SynthCallbacks
): Promise<number> {
  let loaded = await load();
  if (cb.shouldCancel()) return 0;

  const generate = async (chunk: string) => {
    try {
      return await loaded.tts.generate(chunk, { voice, speed });
    } catch (e) {
      if (loaded.backend.device === "cpu") throw e;
      loaded = await fallBackToCpu(loaded, e);
      return loaded.tts.generate(chunk, { voice, speed });
    }
  };

  let parts: Float32Array[] = [];
  let bufferedSamples = 0;
  let rate = 24000;
  let count = 0;

  const flush = () => {
    if (!bufferedSamples) return;
    const merged = new Float32Array(bufferedSamples);
    let o = 0;
    for (const p of parts) {
      merged.set(p, o);
      o += p.length;
    }
    cb.onSegment(encodeWavPCM16(merged, rate), merged.length / rate);
    parts = [];
    bufferedSamples = 0;
  };

  for (const chunk of chunkText(text)) {
    if (cb.shouldCancel()) return count;
    const audio = await generate(chunk);
    parts.push(audio.audio);
    bufferedSamples += audio.audio.length;
    rate = audio.sampling_rate;
    count++;
    cb.onProgress?.(count);
    // bufferSeconds <= 0 → emit each chunk immediately (lowest latency; gapless
    // seams handled by the player). Otherwise group into ~bufferSeconds segments,
    // capped so a huge doc still bounds memory.
    const haveSec = bufferedSamples / rate;
    if (bufferSeconds <= 0 || haveSec >= bufferSeconds || haveSec >= MAX_BUFFER_SEC) {
      flush();
    }
  }
  if (cb.shouldCancel()) return count;
  flush();
  return count;
}
