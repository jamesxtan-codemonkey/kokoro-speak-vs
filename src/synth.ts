// Host-side Kokoro synthesis (onnxruntime-node, ~3x realtime). Runs in the
// extension host — no webview, no CSP, no autoplay. Streams sentences and emits
// concatenated WAV segments. Kept free of `vscode` imports so it can be tested
// in plain Node.

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

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";
const MAX_BUFFER_SEC = 600;

let ttsPromise: Promise<any> | undefined;

export function loadModel(onProgress?: (pct: number) => void): Promise<any> {
  if (!ttsPromise) {
    ttsPromise = kokoro().then((m) =>
      m.KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: DTYPE,
        device: "cpu",
        progress_callback: (p: any) => {
          if (p?.status === "progress" && typeof p.progress === "number") {
            onProgress?.(Math.round(p.progress));
          }
        },
      })
    );
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

/** Stream `text` into concatenated WAV segments. Returns the sentence count. */
export async function synthesize(
  text: string,
  { voice = "af_heart", speed = 1, bufferSeconds = 0 }: SynthOptions,
  cb: SynthCallbacks
): Promise<number> {
  const tts = await loadModel();
  if (cb.shouldCancel()) return 0;

  const { TextSplitterStream } = await kokoro();
  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice: voice as any, speed });
  splitter.push(text);
  splitter.close();

  let parts: Float32Array[] = [];
  let bufferedSamples = 0;
  let rate = 24000;
  let sentences = 0;

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

  for await (const chunk of stream) {
    if (cb.shouldCancel()) return sentences;
    parts.push(chunk.audio.audio);
    bufferedSamples += chunk.audio.audio.length;
    rate = chunk.audio.sampling_rate;
    sentences++;
    cb.onProgress?.(sentences);
    // bufferSeconds <= 0 → emit each sentence immediately (lowest latency;
    // gapless seams handled by the streaming player). Otherwise group into
    // ~bufferSeconds segments, capped so a huge doc still bounds memory.
    const haveSec = bufferedSamples / rate;
    if (bufferSeconds <= 0 || haveSec >= bufferSeconds || haveSec >= MAX_BUFFER_SEC) {
      flush();
    }
  }
  if (cb.shouldCancel()) return sentences;
  flush();
  return sentences;
}
