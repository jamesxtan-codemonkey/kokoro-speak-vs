import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";

// Gapless streaming playback with file-based OS players (afplay can't be fed a
// continuous stream). Each player launch has a fixed startup latency before
// audio begins (~0.85s for afplay). We hide it by spawning segment N+1 exactly
// `duration(N)` after segment N: the constant startup cancels out, so segment
// N+1's audio begins right as segment N's ends. Because host synthesis (~3x
// realtime) outruns playback, the next segment's file is always ready in time.

type PlayerCandidate = [string, string[]];
type CandidateResolver = (file: string) => PlayerCandidate[];

function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function candidates(file: string): PlayerCandidate[] {
  switch (process.platform) {
    case "darwin":
      return [["afplay", [file]]];
    case "win32":
      return [
        [
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `(New-Object System.Media.SoundPlayer ${psSingleQuote(file)}).PlaySync()`,
          ],
        ],
      ];
    default:
      return [
        ["paplay", [file]],
        ["aplay", ["-q", file]],
        ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]],
      ];
  }
}

class SegmentHandle {
  private current: ChildProcess | undefined;
  private cancelled = false;

  set(proc: ChildProcess) {
    this.current = proc;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  kill(sig?: NodeJS.Signals) {
    if (this.cancelled) return;
    safeKill(this.current, sig);
  }

  cancel() {
    this.cancelled = true;
    // SIGCONT first so a paused (SIGSTOP'd) player can receive the kill now;
    // then SIGKILL — afplay (and some other players) can sit blocked in a
    // CoreAudio call and respond slowly to SIGTERM, so audio keeps playing after
    // Stop. SIGKILL is uncatchable and stops the process immediately.
    safeKill(this.current, "SIGCONT");
    safeKill(this.current, "SIGKILL");
  }
}

/** Spawn a player for one file, with fallback across candidates on ENOENT. */
function spawnSegment(
  file: string,
  resolveCandidates: CandidateResolver,
  onExit: () => void,
  onUnavailable: () => void
): SegmentHandle {
  const chain = resolveCandidates(file);
  const handle = new SegmentHandle();
  let finished = false;

  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };

  const tryAt = (i: number) => {
    if (handle.isCancelled) return;
    if (i >= chain.length) {
      finish(onUnavailable);
      return;
    }
    const [cmd, args] = chain[i];
    let retired = false;
    const proc = spawn(cmd, args, { stdio: "ignore" });
    handle.set(proc);
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (finished || retired || handle.isCancelled) return;
      if (err.code === "ENOENT" && i + 1 < chain.length) {
        retired = true;
        tryAt(i + 1);
      } else if (err.code === "ENOENT") {
        finish(onUnavailable);
      } else {
        finish(onExit);
      }
    });
    proc.on("exit", () => {
      if (!retired && !handle.isCancelled) finish(onExit);
    });
  };
  tryAt(0);
  return handle;
}

export interface StreamCallbacks {
  onSpeaking: () => void;
  onIdle: () => void;
  onUnavailable: () => void;
}

export class StreamPlayer {
  private q: Array<{ file: string; dur: number }> = [];
  private next = 0; // index of the next segment to spawn
  private procs = new Set<SegmentHandle>();
  private timer: NodeJS.Timeout | undefined;
  private playHead = 0; // index of the earliest segment not yet finished playing
  private pausedAt: number | undefined; // resume-from index while paused
  private started = false;
  private waiting = false;
  private synthDone = false;
  private stopped = false;
  private completed = false;

  constructor(
    private cb: StreamCallbacks,
    private resolveCandidates: CandidateResolver = candidates
  ) {}

  /** Add a ready segment (its WAV file + audio duration in seconds). */
  add(file: string, dur: number) {
    if (this.stopped || this.completed) return;
    this.q.push({ file, dur });
    if (!this.started) {
      this.started = true;
      this.cb.onSpeaking();
      this.spawn();
    } else if (this.waiting && this.pausedAt === undefined) {
      this.waiting = false;
      this.spawn();
    }
  }

  /** No more segments will be added. */
  end() {
    this.synthDone = true;
    this.checkDone();
  }

  get isActive(): boolean {
    return (
      this.started &&
      !this.stopped &&
      !this.completed &&
      (this.procs.size > 0 ||
        this.waiting ||
        this.timer !== undefined ||
        this.pausedAt !== undefined)
    );
  }
  get isPaused(): boolean {
    return this.pausedAt !== undefined;
  }

  togglePause(): "speaking" | "paused" {
    if (this.isPaused) {
      this.resume();
      return "speaking";
    }
    this.pause();
    return "paused";
  }

  // Pause by KILLING the current player(s), not SIGSTOP. afplay hands the whole
  // (short) sentence to coreaudiod's audio queue, so freezing the afplay process
  // does NOT stop the sound — coreaudiod keeps playing the buffered audio (often
  // the rest of the sentence), which is why SIGSTOP felt slow. Killing the player
  // tears its queue down for instant silence. cancel() suppresses the segment's
  // exit handler, so its WAV is NOT deleted and `playHead` is preserved — the
  // current sentence can be replayed on resume.
  private pause() {
    if (this.stopped || this.isPaused) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const p of this.procs) p.cancel();
    this.procs.clear();
    this.pausedAt = this.playHead; // resume re-plays from the current segment
  }

  // Resume by re-playing from where we paused. The current sentence restarts from
  // its beginning (a killed player can't resume mid-buffer), then streaming
  // continues normally.
  private resume() {
    if (this.pausedAt === undefined) return;
    this.next = this.pausedAt;
    this.pausedAt = undefined;
    if (this.next < this.q.length) {
      this.waiting = false; // about to spawn; not waiting on synthesis (avoids echo)
      this.spawn();
    } else if (this.synthDone) this.checkDone();
    else this.waiting = true; // nothing buffered yet; add() will resume
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const p of this.procs) p.cancel();
    this.procs.clear();
    for (const s of this.q) rmFile(s.file);
    this.q = [];
  }

  private spawn() {
    if (this.stopped || this.completed) return;
    const seg = this.q[this.next];
    if (!seg) {
      this.waiting = !this.synthDone; // synthesis may not have produced it yet
      this.checkDone();
      return;
    }
    const segIndex = this.next;
    this.next++;
    let handle!: SegmentHandle;
    handle = spawnSegment(
      seg.file,
      this.resolveCandidates,
      () => {
        // Natural end of this segment's audio: advance the replay point and
        // delete its file. A pause-kill is cancelled, so this does NOT run then —
        // the file survives and playHead stays put for replay on resume.
        this.procs.delete(handle);
        this.playHead = Math.max(this.playHead, segIndex + 1);
        rmFile(seg.file);
        this.checkDone();
      },
      () => {
        this.cb.onUnavailable();
        this.stop();
      }
    );
    this.procs.add(handle);
    // Schedule the next segment to start when this one's audio ends.
    this.scheduleNext(seg.dur * 1000);
  }

  private scheduleNext(ms: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.spawn();
    }, ms);
  }

  private checkDone() {
    if (this.stopped) return;
    if (
      this.synthDone &&
      this.next >= this.q.length &&
      this.procs.size === 0 &&
      this.timer === undefined &&
      this.pausedAt === undefined
    ) {
      this.completed = true;
      this.waiting = false;
      this.cb.onIdle();
    }
  }
}

function safeKill(p: ChildProcess | undefined, sig?: NodeJS.Signals) {
  if (!p?.pid) return;
  try {
    p.kill(sig);
  } catch {
    /* ignore */
  }
}
function rmFile(file: string) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}
