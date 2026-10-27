// Gapless playback of synthesized clips, and which clip is audible right now
// (for highlighting). Each clip is scheduled to start exactly when the one
// before it ends. Pause suspends the AudioContext, which also freezes the
// clock the highlight follows.

export interface ClipInfo {
  index: number;
  total: number;
  /** Source text range of the clip, for highlighting. */
  start: number;
  end: number;
}

interface Scheduled {
  node: AudioBufferSourceNode;
  t0: number;
  t1: number;
  info: ClipInfo;
}

export class Player {
  onClip: (info: ClipInfo) => void = () => {};
  private ctx: AudioContext | null = null;
  private next = 0;
  private clips: Scheduled[] = [];
  private current: Scheduled | null = null;
  private paused = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private idle: Array<() => void> = [];

  constructor(private rate: number) {}

  enqueue(samples: Float32Array, info: ClipInfo) {
    // "playback" asks for bigger buffers (TTS doesn't need low latency); the
    // context runs at the device rate and each clip is resampled on its way in.
    this.ctx ??= new AudioContext({ latencyHint: "playback" });
    if (this.paused) void this.ctx.suspend();
    else if (this.ctx.state === "suspended") void this.ctx.resume();
    const buf = this.ctx.createBuffer(1, samples.length, this.rate);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const node = this.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.ctx.destination);
    const t0 = Math.max(this.ctx.currentTime + 0.05, this.next);
    node.start(t0);
    this.next = t0 + buf.duration;
    this.clips.push({ node, t0, t1: this.next, info });
    this.timer ??= setInterval(() => this.tick(), 50);
  }

  /** Seconds of audio queued ahead of the playhead. */
  bufferedSec(): number {
    return this.ctx ? Math.max(0, this.next - this.ctx.currentTime) : 0;
  }

  /** Resolves when everything queued has played (or playback is stopped). */
  drained(): Promise<void> {
    return this.clips.length ? new Promise((r) => this.idle.push(r)) : Promise.resolve();
  }

  pause() {
    this.paused = true;
    void this.ctx?.suspend();
  }

  resume() {
    this.paused = false;
    void this.ctx?.resume();
  }

  stop() {
    for (const c of this.clips) {
      try {
        c.node.stop();
      } catch {
        /* not started yet */
      }
    }
    this.clips = [];
    this.current = null;
    this.next = 0;
    this.paused = false;
    void this.ctx?.resume();
    this.finish();
  }

  private finish() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const r of this.idle.splice(0)) r();
  }

  /** The time being heard: the context time minus output latency. */
  private heardTime(ctx: AudioContext): number {
    const ts = ctx.getOutputTimestamp?.();
    return ts?.contextTime ?? ctx.currentTime;
  }

  private tick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = this.heardTime(ctx);
    // Everything queued has played. (Checked first: a long WASM generation can
    // block this page for over a second between ticks.)
    if (t >= this.next) {
      this.clips = [];
      this.current = null;
      this.finish();
      return;
    }
    const playing = this.clips.find((c) => c.t0 <= t && t < c.t1);
    if (playing && playing !== this.current) {
      this.current = playing;
      this.onClip(playing.info);
    }
    this.clips = this.clips.filter((c) => c.t1 > t || c === this.current);
  }
}
