// Offscreen document: runs the model and plays the audio (a service worker can
// do neither). Speaks one job at a time: normalizes the text with a map back to
// the source, chunks it, then generates a little ahead of playback, reporting
// each chunk's source range as it becomes audible so the page can highlight it.

import {
  aiNormalize,
  anthropicCall,
  chunkSpans,
  chunkText,
  normalizeMapped,
  preNormalize,
  SAMPLE_RATE,
} from "../../../src/core";
import type { Job, PlayState, ToBackground, ToOffscreen } from "../messages";
import type { Device, Settings } from "../settings";
import { backendLabel, Engine, errText, loadEngine, loadPreferred } from "./engine";
import { Player } from "./player";

/** Generate at most this far ahead of what's playing. */
const LOOKAHEAD_SEC = 20;
/** Close after this long with nothing playing, freeing the model's memory. */
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

const player = new Player(SAMPLE_RATE);
let engine: Engine | null = null;
let engineDevice: Device | null = null;
let engineNote: string | undefined;
let job: Job | null = null;
let token = 0;
let paused = false;
let preparing = false;
let state: PlayState = { status: "idle" };
let speaking = Promise.resolve();
let rewriting: AbortController | null = null;

const send = (m: ToBackground) => chrome.runtime.sendMessage(m).catch(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let idleTimer: ReturnType<typeof setTimeout> | undefined;

function setState(s: PlayState) {
  state = s;
  void send({ target: "background", type: "state", state: s });
  clearTimeout(idleTimer);
  if (s.status === "idle" || s.status === "error") {
    idleTimer = setTimeout(() => void send({ target: "background", type: "idle-timeout", jobId: s.jobId }), IDLE_UNLOAD_MS);
  }
}

player.onClip = (c) => {
  if (!job) return;
  void send({ target: "background", type: "progress", jobId: job.id, ...c });
  if (state.status === "speaking") setState({ ...state, index: c.index, total: c.total });
};

async function getEngine(device: Device): Promise<Engine> {
  if (engine && engineDevice === device) return engine;
  const prev = engine;
  engine = null;
  await prev?.release();
  const r = await loadPreferred(device);
  engine = r.engine;
  engineDevice = device;
  engineNote = r.note;
  return r.engine;
}

/** The GPU failed mid-run (e.g. device lost after sleep): reload on the CPU. */
async function fallBackToWasm(err: unknown): Promise<Engine> {
  console.warn("[kokoro] WebGPU failed mid-run, switching to WASM:", err);
  const prev = engine;
  engine = null;
  await prev?.release().catch(() => {});
  engine = await loadEngine("wasm");
  engineNote = `GPU failed (${errText(err)}); using CPU.`;
  return engine;
}

async function speak(j: Job, my: number) {
  if (my !== token) return;
  try {
    const s = job!.settings;
    // Chunk the offline normalization, so sentence breaks fall where they do
    // when spoken, and map each chunk back to the text it came from.
    const mt = normalizeMapped(j.text, s.normMode, s);
    const chunks = chunkSpans(mt.text).map((c, index) => ({ index, text: c.text, src: mt.source(c.start, c.end) }));
    if (!chunks.length) {
      finish(my);
      return;
    }
    let e = await getEngine(s.device);
    if (my !== token) return;
    preparing = false;

    const note = j.note ?? (job!.settings.normMode === "ai" && !job!.apiKey ? "AI rewriting needs an API key (Options); using built-in rules." : engineNote);
    setState({ status: paused ? "paused" : "speaking", jobId: j.id, backend: backendLabel(e.backend), message: note, needsAccess: j.needsAccess, index: 0, total: chunks.length });

    for (const c of chunks) {
      while ((paused || player.bufferedSec() > LOOKAHEAD_SEC) && my === token) await sleep(200);
      if (my !== token) return;
      // Settings can change mid-job (voice, speed); later chunks pick them up.
      const cur = job!.settings;
      const raw = j.text.slice(...c.src);
      // A replacement can span several chunks (e.g. a long **bold** passage).
      // Only reuse its source when it represents this entire chunk exactly.
      const wholeSource = (c.index === 0 || chunks[c.index - 1].src[1] <= c.src[0]) &&
        (c.index === chunks.length - 1 || c.src[1] <= chunks[c.index + 1].src[0]) &&
        normalizeMapped(raw, s.normMode, s).text.replace(/\s+/g, " ") === c.text.replace(/\s+/g, " ");
      const local = () => wholeSource && job!.settings !== s ? normalizeMapped(raw, job!.settings.normMode, job!.settings).text : c.text;
      rewriting = new AbortController();
      const call = cur.normMode === "ai" && job!.apiKey ? anthropicCall({ apiKey: job!.apiKey, model: cur.model, timeoutMs: cur.timeoutMs, signal: rewriting.signal }) : null;
      let text = call ? await aiNormalize(wholeSource ? preNormalize(raw, cur) : c.text, cur.rules, call) : local();
      if (my !== token) return;
      if (rewriting.signal.aborted) text = local();
      rewriting = null;
      // AI/user rules can expand a short chunk beyond the model's token cap.
      for (const part of chunkText(text)) {
        while ((paused || player.bufferedSec() > LOOKAHEAD_SEC) && my === token) await sleep(200);
        if (my !== token) return;
        let audio: Float32Array;
        try {
          audio = await e.generate(part, cur.voice, cur.speed);
        } catch (err) {
          if (my !== token) return;
          if (e.backend !== "webgpu") throw err;
          e = await fallBackToWasm(err);
          if (my !== token) return;
          setState({ ...state, backend: backendLabel(e.backend), message: engineNote });
          audio = await e.generate(part, cur.voice, cur.speed);
        }
        if (my !== token) return;
        if (audio.length) player.enqueue(audio, { index: c.index, total: chunks.length, start: c.src[0], end: c.src[1] });
      }
    }
    await player.drained();
    finish(my);
  } catch (err) {
    if (my !== token) return;
    console.error("[kokoro]", err);
    player.stop();
    job = null;
    rewriting = null;
    setState({ status: "error", jobId: j.id, message: `Couldn't speak: ${errText(err)}` });
    void send({ target: "background", type: "done", jobId: j.id });
  }
}

function finish(my: number) {
  if (my !== token || !job) return;
  const jobId = job.id;
  void send({ target: "background", type: "done", jobId });
  job = null;
  setState({ status: "idle", jobId, backend: engine ? backendLabel(engine.backend) : undefined });
}

chrome.runtime.onMessage.addListener((m: ToOffscreen, sender, reply) => {
  if (!m || m.target !== "offscreen" || sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("background.js")) return;
  switch (m.type) {
    case "get-state":
      reply(state);
      return;
    case "speak": {
      const my = ++token;
      rewriting?.abort();
      job = m.job;
      player.stop();
      paused = !!m.job.paused;
      preparing = true;
      if (paused) player.pause();
      setState({ status: paused ? "paused" : "loading", jobId: m.job.id });
      // A cancelled inference must finish before another uses/releases sessions.
      speaking = speaking.then(() => speak(m.job, my));
      break;
    }
    case "pause":
      if (!job) break;
      paused = true;
      player.pause();
      setState({ ...state, status: "paused" });
      break;
    case "resume":
      if (!job) break;
      paused = false;
      player.resume();
      setState({ ...state, status: preparing ? "loading" : "speaking" });
      break;
    case "stop":
      token++;
      rewriting?.abort();
      job = null;
      player.stop();
      setState({ status: "idle", jobId: state.jobId, backend: engine ? backendLabel(engine.backend) : undefined });
      break;
    case "settings":
      if (job) {
        rewriting?.abort();
        job = { ...job, settings: m.settings, apiKey: m.apiKey };
      }
      break;
  }
  reply(true);
});

setState(state);
void send({ target: "background", type: "offscreen-ready" });
