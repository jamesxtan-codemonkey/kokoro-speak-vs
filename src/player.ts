import { spawn, ChildProcess } from "child_process";

// Plays a WAV file via the OS audio player. Synthesis happens in the webview
// (WASM, no native deps); playback happens here so we sidestep the webview
// autoplay-gesture restriction entirely. Pause/resume use SIGSTOP/SIGCONT.

type Handle = { proc: ChildProcess; paused: boolean };

/** Ordered candidate commands per platform; first that launches wins. */
function candidates(file: string): Array<[string, string[]]> {
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
            `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`,
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

export type PlayState = "speaking" | "paused" | "idle";

export class AudioPlayer {
  private current: Handle | undefined;

  /** Start playing `file`; `onDone` fires on natural finish (not on stop()). */
  play(file: string, onDone: () => void): void {
    this.stop();
    const chain = candidates(file);

    const tryAt = (i: number) => {
      const next = chain[i];
      if (!next) {
        onDone();
        return;
      }
      const [cmd, args] = next;
      const proc = spawn(cmd, args, { stdio: "ignore" });
      const handle: Handle = { proc, paused: false };
      this.current = handle;

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (this.current !== handle) return;
        // Player not installed → fall back to the next candidate.
        if (err.code === "ENOENT" && i + 1 < chain.length) {
          tryAt(i + 1);
        } else {
          this.current = undefined;
          onDone();
        }
      });
      proc.on("exit", () => {
        if (this.current !== handle) return;
        this.current = undefined;
        onDone();
      });
    };

    tryAt(0);
  }

  get isActive(): boolean {
    return !!this.current;
  }

  /** Toggle pause/resume. Returns the new state. */
  togglePause(): PlayState {
    const h = this.current;
    if (!h) return "idle";
    if (process.platform === "win32") {
      // PlaySync can't be paused; leave playing.
      return "speaking";
    }
    if (h.paused) {
      h.proc.kill("SIGCONT");
      h.paused = false;
      return "speaking";
    }
    h.proc.kill("SIGSTOP");
    h.paused = true;
    return "paused";
  }

  stop(): void {
    const h = this.current;
    if (!h) return;
    this.current = undefined; // suppress onDone for an intentional stop
    try {
      if (h.paused) h.proc.kill("SIGCONT");
    } catch {
      /* ignore */
    }
    try {
      h.proc.kill();
    } catch {
      /* ignore */
    }
  }
}
