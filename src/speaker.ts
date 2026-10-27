// vscode-free orchestration: turn text into speech and play it on the local
// machine. Reuses the same core as the extension (synth + normalize + the PCM /
// file players), so the MCP server can speak without any VS Code dependency.

import { loadModel, synthesize } from "./synth";
import { createPlayer, AudioPlayer } from "./pcmplayer";
import { getSpeakableText } from "./textprep";
import { normalize, SEED_RULES } from "./normalize";
import { DEFAULT_VOICE, isVoice } from "./core/voices";

export interface SpeakOptions {
  voice?: string;
  speed?: number;
  /** Apply deterministic normalization (Markdown strip + number/symbol expand).
   *  Default true. */
  normalize?: boolean;
}

export interface SpeakResult {
  sentences: number;
  /** false if the call was interrupted by a newer speak()/stop(), or empty. */
  spoken: boolean;
}

function clampSpeed(s: number | undefined): number {
  if (typeof s !== "number" || !isFinite(s)) return 1;
  return Math.max(0.5, Math.min(2, s));
}

/**
 * A reusable speaker: keeps the Kokoro model warm across calls and plays through
 * the native PCM stream (or the file-player fallback). A new speak() interrupts
 * whatever is currently playing.
 */
export class Speaker {
  private player: AudioPlayer | undefined;
  private seq = 0;
  private pendingResolve: (() => void) | undefined;

  /** Preload the model so the first speak() is fast. */
  warm(): Promise<unknown> {
    return loadModel();
  }

  get isActive(): boolean {
    return !!this.player?.isActive;
  }

  /** Synthesize and play `text`; resolves when playback finishes (or is
   *  interrupted by a newer speak()/stop()). */
  async speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
    this.stop(); // interrupt anything currently playing
    const myReq = ++this.seq;
    const cancelled = () => myReq !== this.seq;

    const voice = opts.voice && isVoice(opts.voice) ? opts.voice : DEFAULT_VOICE;
    const speed = clampSpeed(opts.speed);

    let speakText = getSpeakableText("markdown", text);
    if (opts.normalize !== false) {
      speakText = await normalize(speakText, {
        mode: "deterministic",
        rules: SEED_RULES,
        replacements: [],
        spellOut: [],
        // unused in deterministic mode, but required by the type:
        backend: "auto",
        command: "",
        model: "",
        timeoutMs: 20000,
      });
    }
    speakText = speakText.trim();
    if (!speakText) return { sentences: 0, spoken: false };

    await loadModel();
    if (cancelled()) return { sentences: 0, spoken: false };

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.pendingResolve = resolveDone;
    const player = createPlayer({
      onSpeaking: () => {},
      onIdle: () => resolveDone(),
      onUnavailable: () => resolveDone(),
    });
    this.player = player;

    const sentences = await synthesize(
      speakText,
      { voice, speed, bufferSeconds: 0 },
      {
        onSegment: (wav, dur) => {
          if (!cancelled()) player.push(wav, dur);
        },
        shouldCancel: cancelled,
      }
    );
    if (cancelled()) return { sentences, spoken: false };
    player.end();
    await done; // resolves on onIdle, or when stop() interrupts
    return { sentences, spoken: !cancelled() };
  }

  stop(): void {
    this.seq++; // invalidate the in-flight request
    this.player?.stop();
    this.player = undefined;
    this.pendingResolve?.(); // unblock any awaiting speak()
    this.pendingResolve = undefined;
  }
}
