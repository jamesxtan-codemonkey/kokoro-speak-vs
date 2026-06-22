// Host-side Kokoro synthesis (onnxruntime-node, ~3x realtime). Runs in the
// extension host — no webview, no CSP, no autoplay. Streams sentences and emits
// concatenated WAV segments. Kept free of `vscode` imports so it can be tested
// in plain Node.

import * as path from "path";

// kokoro-js is ESM-only. The extension host bundle is CommonJS, and `require()`
// of an ESM package throws ERR_REQUIRE_ESM on the Node that ships inside VS Code.
// Load it via a real dynamic import() that esbuild won't rewrite to require()
// (wrapping in `new Function` hides it from the bundler). Same trick for
// @huggingface/transformers, whose `env` singleton we mutate to load locally.
const importKokoro: () => Promise<any> = new Function(
  "return import('kokoro-js')"
) as any;
const importTransformers: () => Promise<any> = new Function(
  "return import('@huggingface/transformers')"
) as any;

let kokoroMod: any;
async function kokoro(): Promise<any> {
  if (!kokoroMod) kokoroMod = await importKokoro();
  return kokoroMod;
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";
const MAX_BUFFER_SEC = 600;

// The ONNX weights filename transformers.js resolves for each dtype. Kept in
// sync with DTYPE so the offline file list below stays correct.
const ONNX_FILE: Record<string, string> = {
  fp32: "model.onnx",
  fp16: "model_fp16.onnx",
  q8: "model_quantized.onnx",
  q4: "model_q4.onnx",
  q4f16: "model_q4f16.onnx",
  uint8: "model_uint8.onnx",
};

/** HuggingFace repo the model is fetched from when online. */
export const MODEL_REPO_URL = `https://huggingface.co/${MODEL_ID}`;

/** Files (relative to the chosen folder) required for a manual/offline install.
 *  This is the source of truth for the verifier and the user instructions. */
export const REQUIRED_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  `onnx/${ONNX_FILE[DTYPE] ?? "model_quantized.onnx"}`,
];

// Absolute path to a local model folder, or undefined to download from HF.
let localModelPath: string | undefined;
let ttsPromise: Promise<any> | undefined;

/**
 * Point synthesis at a local model folder (offline / air-gapped), or pass
 * undefined to use the online HuggingFace download. Changing the source discards
 * any loaded model so the next loadModel() reloads from the new location.
 */
export function setModelSource(dir: string | undefined): void {
  const next = dir || undefined;
  if (next !== localModelPath) {
    localModelPath = next;
    ttsPromise = undefined;
  }
}

export function loadModel(onProgress?: (pct: number) => void): Promise<any> {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const [m, t] = await Promise.all([kokoro(), importTransformers()]);
      // transformers.js resolves files as `<localModelPath>/<id>/<file>`. Point
      // localModelPath at the parent and use the folder's own name as the id, so
      // the user can name the folder anything and just drop the files inside.
      let id = MODEL_ID;
      if (localModelPath) {
        t.env.allowLocalModels = true;
        t.env.allowRemoteModels = false; // never reach the network offline
        t.env.localModelPath = path.dirname(localModelPath);
        id = path.basename(localModelPath);
      } else {
        t.env.allowRemoteModels = true;
      }
      return m.KokoroTTS.from_pretrained(id, {
        dtype: DTYPE,
        device: "cpu",
        progress_callback: (p: any) => {
          if (p?.status === "progress" && typeof p.progress === "number") {
            onProgress?.(Math.round(p.progress));
          }
        },
      });
    })();
    // If the load rejects, clear the cached promise so a later retry (e.g. after
    // the user points us at a local folder) actually re-runs.
    ttsPromise.catch(() => {
      ttsPromise = undefined;
    });
  }
  return ttsPromise;
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
  const tts = await loadModel();
  if (cb.shouldCancel()) return 0;

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
    const audio = await tts.generate(chunk, { voice: voice as any, speed });
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
