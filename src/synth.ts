// Host-side Kokoro synthesis (onnxruntime-node: CPU ~3-4x realtime, DirectML GPU
// on Windows ~25x). Runs in the
// extension host — no webview, no CSP, no autoplay. Streams sentences and emits
// concatenated WAV segments. Kept free of `vscode` imports so it can be tested
// in plain Node.

import * as fs from "fs";
import * as path from "path";

// kokoro-js is ESM-only. The extension host bundle is CommonJS, and `require()`
// of an ESM package throws ERR_REQUIRE_ESM on the Node that ships inside VS Code.
// Load it via a real dynamic import() that esbuild won't rewrite to require()
// (wrapping in `new Function` hides it from the bundler).
const importKokoro: () => Promise<any> = new Function(
  "return import('kokoro-js')"
) as any;

// Same trick for transformers.js (kokoro-js's runtime), whose `env` decides where
// model files come from. Both resolve to the same module instance.
const importTransformers: () => Promise<any> = new Function(
  "return import('@huggingface/transformers')"
) as any;

let kokoroMod: any;
async function kokoro(): Promise<any> {
  if (!kokoroMod) kokoroMod = await importKokoro();
  return kokoroMod;
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MAX_BUFFER_SEC = 600;

// The packaged extension ships the q8 model in <extension>/models (see
// scripts/fetch-model.mjs), so it works offline out of the box. This file is
// bundled to dist/*.js (or test/*.cjs), so the models dir is one level up.
const BUNDLED_MODELS_DIR = path.join(__dirname, "..", "models");

/** ONNX file name suffix per precision (transformers.js convention). */
const DTYPE_SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized" };

interface Storage {
  /** Where on-demand downloads (e.g. fp32) are cached; default: transformers.js's. */
  cacheDir?: string;
  /** Never download — use only bundled/cached files. */
  offline: boolean;
}
let storage: Storage = { offline: process.env.KOKORO_SPEAK_OFFLINE === "1" };
let tfEnv: any;

/** Set where downloaded model files are cached (the extension uses its global
 *  storage, so downloads survive extension updates) and/or force offline. */
export function configureModelStorage(next: Partial<Storage>): void {
  storage = { ...storage, ...next };
  if (tfEnv) applyStorage(tfEnv);
}

function applyStorage(env: any) {
  env.allowLocalModels = true;
  env.localModelPath = BUNDLED_MODELS_DIR;
  if (storage.cacheDir) env.cacheDir = storage.cacheDir;
  env.allowRemoteModels = !storage.offline;
}

async function modelEnv(): Promise<any> {
  if (!tfEnv) {
    tfEnv = (await importTransformers()).env;
    applyStorage(tfEnv);
  }
  return tfEnv;
}

/** True if this precision's weights are on disk (bundled or downloaded), i.e.
 *  loading it won't hit the network. */
export function modelIsLocal(dtype: string): boolean {
  const suffix = DTYPE_SUFFIX[dtype];
  if (suffix === undefined) return false;
  const rel = path.join(MODEL_ID, "onnx", `model${suffix}.onnx`);
  const dirs = [BUNDLED_MODELS_DIR, storage.cacheDir ?? tfEnv?.cacheDir].filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d as string, rel)));
}

/** "auto" = the platform GPU if there is one (DirectML on Windows), else CPU. */
export type DevicePref = "auto" | "gpu" | "cpu";
/** Model weights: "auto" picks per device (see resolvePrecision). */
export type PrecisionPref = "auto" | "q8" | "fp16" | "fp32";

export interface ModelPrefs {
  device: DevicePref;
  precision: PrecisionPref;
}

/** The backend a loaded model actually runs on. */
export interface Backend {
  /** transformers.js device id: "dml" | "cpu". */
  device: string;
  dtype: string;
  /** Why we're not on the preferred GPU, if we fell back. */
  fallbackReason?: string;
  /** A faster precision for this device that isn't on disk yet (download on
   *  demand via upgradeModel()). */
  upgrade?: string;
}

/** GPU execution provider this platform's onnxruntime-node ships, if any.
 *  Windows bundles DirectML (any D3D12 GPU: NVIDIA, AMD, Intel). */
export function gpuDevice(platform: string = process.platform): string | undefined {
  return platform === "win32" ? "dml" : undefined;
}

/**
 * Weights per device. Measured on Windows x64 (RTX 4090 / i7-10700, ORT 1.30):
 * - dml: q8 ≈ 28x realtime. fp32/fp16 drop to ≈ 6x — DirectML only keeps its
 *   fast path for the first input shape, and every sentence has a new length.
 * - cpu (x64): q8 ≈ 1.2x (too slow — playback outruns synthesis), fp32 ≈ 4x.
 * Elsewhere CPU keeps q8 (≈ 3x on Apple silicon, 1/4 the download).
 */
export function resolvePrecision(
  pref: PrecisionPref,
  device: string,
  platform: string = process.platform,
  arch: string = process.arch
): string {
  if (pref !== "auto") return pref;
  if (device === "cpu" && platform === "win32" && arch === "x64") return "fp32";
  return "q8";
}

/**
 * Ordered backends to try: the GPU first (if wanted and present), then CPU.
 * With auto precision, a preferred precision that isn't on disk is swapped for
 * the bundled q8 (so it works offline) and offered as an `upgrade` instead.
 */
export function planBackends(
  prefs: ModelPrefs,
  platform: string = process.platform,
  arch: string = process.arch,
  isLocal: (dtype: string) => boolean = modelIsLocal
): Backend[] {
  const pick = (device: string): Backend => {
    const dtype = resolvePrecision(prefs.precision, device, platform, arch);
    return prefs.precision === "auto" && dtype !== "q8" && !isLocal(dtype)
      ? { device, dtype: "q8", upgrade: dtype }
      : { device, dtype };
  };
  const plan: Backend[] = [];
  const gpu = gpuDevice(platform);
  if (prefs.device !== "cpu" && gpu) plan.push(pick(gpu));
  const cpu = pick("cpu");
  if (prefs.device === "gpu" && !gpu) {
    cpu.fallbackReason = `no GPU backend on ${platform}`;
  }
  plan.push(cpu);
  return plan;
}

interface Loaded {
  tts: any;
  backend: Backend;
}

let prefs: ModelPrefs = { device: "auto", precision: "auto" };
let loadedPromise: Promise<Loaded> | undefined;
let backend: Backend | undefined;

/** Set device/precision. A change drops the loaded model; the next
 *  loadModel() reloads it on the new backend. */
export function configureModel(next: ModelPrefs): void {
  if (next.device === prefs.device && next.precision === prefs.precision) return;
  prefs = { ...next };
  loadedPromise = undefined;
  backend = undefined;
}

/** The backend the current model runs on (undefined until loaded). */
export function currentBackend(): Backend | undefined {
  return backend;
}

export function describeBackend(b: Backend): string {
  const where = b.device === "dml" ? "GPU (DirectML)" : b.device === "cpu" ? "CPU" : b.device;
  return `${where}, ${b.dtype}`;
}

function errText(e: unknown): string {
  return String((e as any)?.message ?? e).split("\n")[0].slice(0, 200);
}

async function loadOn(b: Backend, onProgress?: (pct: number) => void): Promise<any> {
  await modelEnv();
  const m = await kokoro();
  const tts = await m.KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: b.dtype,
    device: b.device,
    progress_callback: (p: any) => {
      if (p?.status === "progress" && typeof p.progress === "number") {
        onProgress?.(Math.round(p.progress));
      }
    },
  });
  // A GPU can accept the model at load and still reject an op at run time
  // (e.g. DirectML on older onnxruntime fails Kokoro's ConvTranspose), so prove
  // it with one short line. This also compiles the GPU kernels up front.
  if (b.device !== "cpu") await tts.generate("Ready.", { voice: "af_heart" });
  return tts;
}

async function loadWithFallback(
  plan: Backend[],
  onProgress?: (pct: number) => void
): Promise<Loaded> {
  let lastErr: unknown;
  let reason: string | undefined;
  for (const b of plan) {
    try {
      const tts = await loadOn(b, onProgress);
      return { tts, backend: { ...b, fallbackReason: b.fallbackReason ?? reason } };
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
function track(p: Promise<Loaded>): Promise<Loaded> {
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

function load(onProgress?: (pct: number) => void): Promise<Loaded> {
  return (
    loadedPromise ??
    track(
      // Plan after the env is set up: planning checks which weights are on disk.
      modelEnv().then(() => loadWithFallback(planBackends(prefs), onProgress))
    )
  );
}

export function loadModel(onProgress?: (pct: number) => void): Promise<any> {
  return load(onProgress).then((l) => l.tts);
}

/** Download (if needed) and switch to the current backend's suggested faster
 *  precision. Resolves to the new backend; throws (staying on the current
 *  model) if the download or load fails. */
export async function upgradeModel(onProgress?: (pct: number) => void): Promise<Backend> {
  const cur = (await load()).backend;
  if (!cur.upgrade) return cur;
  const next: Backend = { device: cur.device, dtype: cur.upgrade, fallbackReason: cur.fallbackReason };
  const prev = loadedPromise;
  const p = loadWithFallback([next], onProgress);
  const loaded = await p; // on failure the current model stays loaded
  // Adopt it unless the settings changed (and dropped the model) meanwhile.
  if (loadedPromise === prev) {
    loadedPromise = p;
    backend = loaded.backend;
  }
  return loaded.backend;
}

/** The GPU failed mid-run (e.g. device lost after sleep): reload on CPU. */
function fallBackToCpu(failed: Backend, err: unknown): Promise<Loaded> {
  const cpu = planBackends(prefs).find((b) => b.device === "cpu")!;
  cpu.fallbackReason = `${failed.device} failed: ${errText(err)}`;
  console.warn(`[kokoro-speak] ${cpu.fallbackReason}; switching to CPU`);
  return track(loadWithFallback([cpu]));
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

// Kokoro truncates any single generation past its ~512-token cap. Kokoro's own
// TextSplitterStream batches greedily and can hand the model an over-long chunk
// (e.g. when sentence detection misses `." ` or a lowercase follower), silently
// dropping the tail. So we chunk the text ourselves and generate per chunk, with
// each chunk kept well under the cap.
const MAX_CHUNK_CHARS = 250;

/** Greedily pack a long sentence into <=maxChars pieces at word boundaries
 *  (hard-splitting any single oversized token). */
function packWords(s: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (let p of s.split(/\s+/)) {
    while (p.length > maxChars) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(p.slice(0, maxChars));
      p = p.slice(maxChars);
    }
    if (!cur) cur = p;
    else if (cur.length + 1 + p.length <= maxChars) cur += " " + p;
    else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split text into synthesis-sized chunks so no single Kokoro generation exceeds
 * its token cap (which would truncate, dropping the tail). Splits on sentence
 * boundaries — `.`/`!`/`?` optionally followed by a closing quote/paren, then
 * whitespace, plus newlines — then word-packs any still-too-long sentence.
 */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const sentences = text
    .split(/(?<=[.!?]["')\]]?)\s+/)
    .flatMap((s) => s.split(/\n+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) chunks.push(s);
    else chunks.push(...packWords(s, maxChars));
  }
  return chunks;
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
      return await loaded.tts.generate(chunk, { voice: voice as any, speed });
    } catch (e) {
      if (loaded.backend.device === "cpu") throw e;
      loaded = await fallBackToCpu(loaded.backend, e);
      return loaded.tts.generate(chunk, { voice: voice as any, speed });
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
