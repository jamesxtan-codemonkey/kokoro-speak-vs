"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/player.ts
var player_exports = {};
__export(player_exports, {
  StreamPlayer: () => StreamPlayer
});
module.exports = __toCommonJS(player_exports);
var import_child_process = require("child_process");
var fs = __toESM(require("fs"));
function candidates(file) {
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
            `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`
          ]
        ]
      ];
    default:
      return [
        ["paplay", [file]],
        ["aplay", ["-q", file]],
        ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]]
      ];
  }
}
function spawnSegment(file, onExit, onUnavailable) {
  const chain = candidates(file);
  let proc;
  const tryAt = (i) => {
    const [cmd, args] = chain[i];
    proc = (0, import_child_process.spawn)(cmd, args, { stdio: "ignore" });
    proc.on("error", (err) => {
      if (err.code === "ENOENT" && i + 1 < chain.length) tryAt(i + 1);
      else if (err.code === "ENOENT") onUnavailable();
      else onExit();
    });
    proc.on("exit", onExit);
  };
  tryAt(0);
  return proc;
}
var StreamPlayer = class {
  constructor(cb) {
    this.cb = cb;
  }
  q = [];
  next = 0;
  // index of the next segment to spawn
  procs = /* @__PURE__ */ new Set();
  timer;
  timerEndsAt = 0;
  pausedRemaining;
  started = false;
  waiting = false;
  synthDone = false;
  stopped = false;
  /** Add a ready segment (its WAV file + audio duration in seconds). */
  add(file, dur) {
    if (this.stopped) return;
    this.q.push({ file, dur });
    if (!this.started) {
      this.started = true;
      this.cb.onSpeaking();
      this.spawn();
    } else if (this.waiting && this.pausedRemaining === void 0) {
      this.waiting = false;
      this.spawn();
    }
  }
  /** No more segments will be added. */
  end() {
    this.synthDone = true;
    this.checkDone();
  }
  get isActive() {
    return this.started && !this.stopped && (this.procs.size > 0 || this.waiting || this.timer !== void 0 || this.pausedRemaining !== void 0);
  }
  get isPaused() {
    return this.pausedRemaining !== void 0;
  }
  togglePause() {
    if (this.isPaused) {
      this.resume();
      return "speaking";
    }
    this.pause();
    return "paused";
  }
  pause() {
    if (this.stopped || this.isPaused) return;
    for (const p of this.procs) safeKill(p, "SIGSTOP");
    if (this.timer) {
      clearTimeout(this.timer);
      this.pausedRemaining = Math.max(0, this.timerEndsAt - Date.now());
      this.timer = void 0;
    } else {
      this.pausedRemaining = 0;
    }
  }
  resume() {
    if (this.pausedRemaining === void 0) return;
    for (const p of this.procs) safeKill(p, "SIGCONT");
    const ms = this.pausedRemaining;
    this.pausedRemaining = void 0;
    if (this.next < this.q.length) this.scheduleNext(ms);
    else this.waiting = true;
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = void 0;
    for (const p of this.procs) {
      safeKill(p, "SIGCONT");
      safeKill(p);
    }
    this.procs.clear();
    for (const s of this.q) rmFile(s.file);
    this.q = [];
  }
  spawn() {
    if (this.stopped) return;
    const seg = this.q[this.next];
    if (!seg) {
      this.waiting = true;
      this.checkDone();
      return;
    }
    this.next++;
    const proc = spawnSegment(
      seg.file,
      () => {
        this.procs.delete(proc);
        rmFile(seg.file);
        this.checkDone();
      },
      () => {
        this.cb.onUnavailable();
        this.stop();
      }
    );
    this.procs.add(proc);
    this.scheduleNext(seg.dur * 1e3);
  }
  scheduleNext(ms) {
    this.timerEndsAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = void 0;
      this.spawn();
    }, ms);
  }
  checkDone() {
    if (this.stopped) return;
    if (this.synthDone && this.next >= this.q.length && this.procs.size === 0 && this.timer === void 0 && this.pausedRemaining === void 0) {
      this.cb.onIdle();
    }
  }
};
function safeKill(p, sig) {
  try {
    p.kill(sig);
  } catch {
  }
}
function rmFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StreamPlayer
});
