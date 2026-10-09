// PCM streaming via audify (RtAudio → CoreAudio on macOS, WASAPI on Windows,
// ALSA/Pulse on Linux). One persistent
// output stream that we write 16-bit PCM frames into as sentences synthesize, for
// native gapless playback with exact pause/resume and instant stop.
//
// Why we keep every frame and write it all ahead: synthesis (onnxruntime, ~3x)
// runs on the main thread and blocks the event loop, so we can't rely on a
// just-in-time feed — we push the whole utterance into audify's queue and its own
// audio thread plays it smoothly regardless. The catch is that audify.stop()
// DRAINS the queue, so it can't pause a full queue. Instead, pause =
// clearOutputQueue() + stop() (instant), and resume = re-write the not-yet-played
// frames (tracked via the per-frame output callback) and start() again.
//
// audify is a native N-API addon (ABI-stable, prebuilt), injected/loaded lazily
// so a load failure degrades to the file-based player (see extension.ts) instead
// of crashing. Kept free of `vscode` imports so it can be unit-tested.

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { StreamPlayer } from "./player";

export interface AudioCallbacks {
  onSpeaking: () => void;
  onIdle: () => void;
  onUnavailable: () => void;
}

/** Common surface for both the PCM streamer and the file-based fallback. */
export interface AudioPlayer {
  /** Queue one synthesized segment (a 16-bit PCM mono WAV buffer). */
  push(wav: Buffer, dur: number): void;
  /** No more segments will be pushed. */
  end(): void;
  togglePause(): "speaking" | "paused";
  stop(): void;
  readonly isActive: boolean;
  readonly isPaused: boolean;
}

// Lazy, failure-tolerant load of the native module. `undefined` = not tried yet,
// `null` = unavailable.
let audifyMod: any;
function loadAudify(): any {
  if (audifyMod === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      audifyMod = require("audify");
    } catch {
      audifyMod = null;
    }
  }
  return audifyMod;
}

/** Read a 16-bit PCM mono WAV buffer (as written by encodeWavPCM16) → samples. */
export function readWav(wav: Buffer): { samples: Int16Array; rate: number } {
  const rate = wav.readUInt32LE(24);
  const dataLen = wav.readUInt32LE(40);
  const start = 44;
  const n = Math.max(0, Math.min(dataLen, wav.length - start)) >> 1;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = wav.readInt16LE(start + i * 2);
  return { samples, rate };
}

/** Linear-resample mono int16 from srcRate to dstRate. Speech-quality, cheap. */
export function resample(
  src: Int16Array,
  srcRate: number,
  dstRate: number
): Int16Array {
  if (srcRate === dstRate || src.length === 0) return src;
  const ratio = dstRate / srcRate;
  const outLen = Math.max(1, Math.round(src.length * ratio));
  const out = new Int16Array(outLen);
  for (let j = 0; j < outLen; j++) {
    const pos = j / ratio;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = src[i] ?? src[src.length - 1];
    const b = src[i + 1] ?? a;
    out[j] = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac)));
  }
  return out;
}

/** Pack mono int16 samples into little-endian bytes for `channels` output
 *  channels. For stereo, each sample is duplicated to L and R so mono speech is
 *  heard on both speakers. */
export function toChannelBytes(mono: Int16Array, channels: number): Buffer {
  if (channels <= 1) {
    return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength);
  }
  const out = Buffer.alloc(mono.length * channels * 2);
  let o = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i];
    for (let c = 0; c < channels; c++) {
      out.writeInt16LE(v, o);
      o += 2;
    }
  }
  return out;
}

export class PcmStreamPlayer implements AudioPlayer {
  private rt: any;
  private rate = 48000; // device output rate
  private channels = 2; // 2 = duplicate mono → L+R (else mono plays one speaker)
  private frameSamples = 960;
  private frameBytes = 1920;
  private frames: Buffer[] = []; // every produced frame, retained for replay
  private acc: Buffer = Buffer.alloc(0); // bytes not yet a full frame
  private writeIndex = 0; // next frame index to write to the device
  private playIndex = 0; // frames the device reports finished playing
  private started = false;
  private paused = false;
  private stopped = false;
  private completed = false;
  private synthDone = false;
  private backstop: ReturnType<typeof setInterval> | undefined;

  /** Open a CoreAudio output stream, or return null if audify/the device is
   *  unavailable so the caller can fall back to the file-based player.
   *  `mod` is injectable for tests. */
  static tryCreate(
    cb: AudioCallbacks,
    mod: any = loadAudify()
  ): PcmStreamPlayer | null {
    if (!mod) return null;
    try {
      return new PcmStreamPlayer(cb, mod);
    } catch {
      return null;
    }
  }

  private constructor(
    private cb: AudioCallbacks,
    mod: any
  ) {
    const { RtAudio, RtAudioFormat, RtAudioApi } = mod;
    // Windows: pin WASAPI (shared mode, the system mixer). RtAudio's default
    // probe order tries ASIO first, which grabs pro-audio interfaces exclusively.
    this.rt =
      process.platform === "win32" && RtAudioApi?.WINDOWS_WASAPI !== undefined
        ? new RtAudio(RtAudioApi.WINDOWS_WASAPI)
        : new RtAudio();
    const id = this.rt.getDefaultOutputDevice();
    const dev = this.rt.getDevices().find((d: any) => d.id === id);
    if (!dev) throw new Error("no default output device");
    const rates: number[] = dev.sampleRates ?? [];
    this.rate = rates.includes(48000) ? 48000 : dev.preferredSampleRate || 48000;
    // Output stereo so mono speech is heard on BOTH speakers (a mono stream maps
    // to one channel = left-only). Fall back to mono only for a mono-only device.
    this.channels = (dev.outputChannels ?? 2) >= 2 ? 2 : 1;
    this.frameSamples = Math.max(1, Math.round(this.rate * 0.02)); // ~20 ms
    this.frameBytes = this.frameSamples * this.channels * 2;
    this.rt.openStream(
      { deviceId: id, nChannels: this.channels, firstChannel: 0 },
      null,
      RtAudioFormat.RTAUDIO_SINT16,
      this.rate,
      this.frameSamples,
      "Kokoro Speak",
      null, // inputCallback
      () => this.onFramePlayed(), // frameOutputCallback: one call per frame played
      0,
      null
    );
  }

  get isActive(): boolean {
    return this.started && !this.stopped && !this.completed;
  }
  get isPaused(): boolean {
    return this.paused;
  }

  push(wav: Buffer, _dur: number): void {
    if (this.stopped || this.completed) return;
    const { samples, rate } = readWav(wav);
    const pcm = resample(samples, rate, this.rate);
    let bytes = toChannelBytes(pcm, this.channels);
    if (this.acc.length) bytes = Buffer.concat([this.acc, bytes]);
    let off = 0;
    while (bytes.length - off >= this.frameBytes) {
      // Copy: subarray shares memory with the transient `bytes`.
      this.frames.push(Buffer.from(bytes.subarray(off, off + this.frameBytes)));
      off += this.frameBytes;
    }
    this.acc = off < bytes.length ? Buffer.from(bytes.subarray(off)) : Buffer.alloc(0);
    this.pump();
  }

  /** Start on first data, then write every not-yet-written frame to the device. */
  private pump(): void {
    if (this.stopped || this.completed || this.paused) return;
    if (!this.started) {
      this.started = true;
      this.rt.start();
      this.cb.onSpeaking();
    }
    while (this.writeIndex < this.frames.length) {
      this.rt.write(this.frames[this.writeIndex]);
      this.writeIndex++;
    }
  }

  end(): void {
    if (this.stopped || this.completed) return;
    this.synthDone = true;
    if (this.acc.length) {
      const pad = Buffer.alloc(this.frameBytes - this.acc.length, 0);
      this.frames.push(Buffer.concat([this.acc, pad]));
      this.acc = Buffer.alloc(0);
    }
    this.pump();
    if (!this.started) {
      // Nothing was ever queued (empty/whitespace text).
      this.finish();
      return;
    }
    this.startBackstop();
    this.maybeFinish();
  }

  private onFramePlayed(): void {
    if (this.stopped || this.completed) return;
    this.playIndex++;
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.synthDone && this.playIndex >= this.frames.length) this.finish();
  }

  togglePause(): "speaking" | "paused" {
    if (this.paused) {
      this.resume();
      return "speaking";
    }
    this.pause();
    return "paused";
  }

  private pause(): void {
    if (!this.started || this.stopped || this.completed || this.paused) return;
    this.paused = true;
    this.stopBackstop();
    // Drop the queued (unplayed) frames and halt output now — instant silence.
    try {
      this.rt.clearOutputQueue();
    } catch {
      /* ignore */
    }
    try {
      this.rt.stop();
    } catch {
      /* ignore */
    }
    // Resume must re-send everything from the frame that was actually playing.
    this.writeIndex = this.playIndex;
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    try {
      this.rt.start();
    } catch {
      /* ignore */
    }
    this.pump(); // re-writes frames[playIndex .. end]
    if (this.synthDone) this.startBackstop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopBackstop();
    this.cleanup();
  }

  private finish(): void {
    if (this.stopped || this.completed) return;
    this.completed = true;
    this.stopBackstop();
    this.cb.onIdle();
    // Tear the stream down off the callback stack.
    setImmediate(() => this.cleanup());
  }

  // Safety net: if the per-frame callback ever misses the final frame, this still
  // settles the status shortly after playback should have finished.
  private startBackstop(): void {
    this.stopBackstop();
    this.backstop = setInterval(() => {
      if (!this.paused && this.synthDone && this.playIndex >= this.frames.length) {
        this.finish();
      }
    }, 200);
  }
  private stopBackstop(): void {
    if (this.backstop) {
      clearInterval(this.backstop);
      this.backstop = undefined;
    }
  }

  private cleanup(): void {
    try {
      this.rt.clearOutputQueue();
    } catch {
      /* ignore */
    }
    try {
      this.rt.stop();
    } catch {
      /* ignore */
    }
    try {
      this.rt.closeStream();
    } catch {
      /* ignore */
    }
  }
}

// ---- file-based fallback (OS CLI players) ---------------------------------

let tempSeq = 0;

/** Write a WAV segment to a unique temp file and return its path. */
export function writeTemp(wav: Buffer): string {
  const file = path.join(
    os.tmpdir(),
    `kokoro-speak-${process.pid}-${tempSeq++}.wav`
  );
  fs.writeFileSync(file, wav);
  return file;
}

/**
 * Fallback player: writes each WAV segment to a temp file and plays it with the
 * OS CLI player (afplay/paplay/…). Used when native PCM streaming is
 * unavailable. Adapts the file-based StreamPlayer to the AudioPlayer surface.
 */
export class FileAudioPlayer implements AudioPlayer {
  private sp: StreamPlayer;
  constructor(cb: AudioCallbacks) {
    this.sp = new StreamPlayer(cb);
  }
  push(wav: Buffer, dur: number) {
    this.sp.add(writeTemp(wav), dur);
  }
  end() {
    this.sp.end();
  }
  togglePause() {
    return this.sp.togglePause();
  }
  stop() {
    this.sp.stop();
  }
  get isActive() {
    return this.sp.isActive;
  }
  get isPaused() {
    return this.sp.isPaused;
  }
}

/** Prefer native PCM streaming (audify → CoreAudio); fall back to the file
 *  player if audify can't load or there's no output device. */
export function createPlayer(cb: AudioCallbacks): AudioPlayer {
  return PcmStreamPlayer.tryCreate(cb) ?? new FileAudioPlayer(cb);
}
