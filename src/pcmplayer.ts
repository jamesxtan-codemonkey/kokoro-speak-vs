// macOS-first PCM streaming via audify (RtAudio → CoreAudio). One persistent
// output stream that we write int16 frames into as sentences synthesize, for
// native gapless playback with EXACT pause/resume and instant stop — none of the
// afplay/CoreAudio buffering that made the file-based player laggy.
//
// audify is a native N-API addon (ABI-stable, prebuilt), loaded lazily so a load
// failure degrades to the file-based player (see extension.ts) instead of
// crashing. Kept free of `vscode` imports so the pure helpers can be unit-tested.

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

export class PcmStreamPlayer implements AudioPlayer {
  private rt: any;
  private rate = 48000; // device output rate
  private frameSamples = 960;
  private frameBytes = 1920;
  private acc: Buffer = Buffer.alloc(0); // bytes not yet a full frame
  private writtenSamples = 0; // total device-rate samples handed to the device
  private startedAt = 0;
  private pausedAccum = 0; // total ms spent paused
  private pauseStart = 0;
  private started = false;
  private paused = false;
  private stopped = false;
  private completed = false;
  private synthDone = false;
  private doneTimer: ReturnType<typeof setTimeout> | undefined;

  /** Open a CoreAudio output stream, or return null if audify/the device is
   *  unavailable so the caller can fall back to the file-based player. */
  static tryCreate(cb: AudioCallbacks): PcmStreamPlayer | null {
    const mod = loadAudify();
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
    const { RtAudio, RtAudioFormat } = mod;
    this.rt = new RtAudio();
    const id = this.rt.getDefaultOutputDevice();
    const dev = this.rt.getDevices().find((d: any) => d.id === id);
    if (!dev) throw new Error("no default output device");
    // Prefer 48 kHz (a clean 2× of Kokoro's 24 kHz); else the device default.
    const rates: number[] = dev.sampleRates ?? [];
    this.rate = rates.includes(48000) ? 48000 : dev.preferredSampleRate || 48000;
    this.frameSamples = Math.max(1, Math.round(this.rate * 0.02)); // ~20 ms
    this.frameBytes = this.frameSamples * 2;
    this.rt.openStream(
      { deviceId: id, nChannels: 1, firstChannel: 0 },
      null,
      RtAudioFormat.RTAUDIO_SINT16,
      this.rate,
      this.frameSamples,
      "Kokoro Speak",
      null,
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
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.acc = this.acc.length ? Buffer.concat([this.acc, bytes]) : Buffer.from(bytes);
    if (!this.started) {
      this.started = true;
      this.startedAt = Date.now();
      this.rt.start();
      this.cb.onSpeaking();
    }
    this.drain(false);
  }

  /** Write whole frames to the device; on `final`, pad the last partial frame. */
  private drain(final: boolean): void {
    let off = 0;
    while (this.acc.length - off >= this.frameBytes) {
      this.rt.write(this.acc.subarray(off, off + this.frameBytes));
      off += this.frameBytes;
      this.writtenSamples += this.frameSamples;
    }
    this.acc = off ? Buffer.from(this.acc.subarray(off)) : this.acc;
    if (final && this.acc.length) {
      const pad = Buffer.alloc(this.frameBytes - this.acc.length, 0);
      this.rt.write(Buffer.concat([this.acc, pad]));
      this.writtenSamples += this.frameSamples;
      this.acc = Buffer.alloc(0);
    }
  }

  end(): void {
    if (this.stopped || this.completed) return;
    this.synthDone = true;
    if (!this.started) {
      // Nothing was ever queued (e.g. empty/whitespace text).
      this.completed = true;
      this.cleanup();
      this.cb.onIdle();
      return;
    }
    this.drain(true);
    this.scheduleDone();
  }

  private activePlayedMs(): number {
    const ref = this.paused ? this.pauseStart : Date.now();
    return Math.max(0, ref - this.startedAt - this.pausedAccum);
  }

  /** Playback is continuous (synthesis stays ahead of realtime), so the end time
   *  is just startedAt + audioDuration + time spent paused. Fire onIdle then. */
  private scheduleDone(): void {
    if (this.doneTimer) {
      clearTimeout(this.doneTimer);
      this.doneTimer = undefined;
    }
    if (!this.synthDone || this.paused || this.stopped) return;
    const totalMs = (this.writtenSamples / this.rate) * 1000;
    const remaining = Math.max(0, totalMs - this.activePlayedMs());
    this.doneTimer = setTimeout(() => this.finish(), remaining + 80);
  }

  private finish(): void {
    if (this.stopped || this.completed) return;
    this.completed = true;
    this.cleanup();
    this.cb.onIdle();
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
    if (!this.started || this.stopped || this.paused || this.completed) return;
    this.paused = true;
    this.pauseStart = Date.now();
    if (this.doneTimer) {
      clearTimeout(this.doneTimer);
      this.doneTimer = undefined;
    }
    // stop() halts the device output immediately at the exact sample; the queued
    // audio is retained, so start() resumes from precisely where we left off.
    try {
      this.rt.stop();
    } catch {
      /* ignore */
    }
  }

  private resume(): void {
    if (!this.paused) return;
    this.pausedAccum += Date.now() - this.pauseStart;
    this.paused = false;
    try {
      this.rt.start();
    } catch {
      /* ignore */
    }
    this.scheduleDone();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.doneTimer) {
      clearTimeout(this.doneTimer);
      this.doneTimer = undefined;
    }
    this.cleanup();
  }

  private cleanup(): void {
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
