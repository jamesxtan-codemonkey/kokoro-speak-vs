// Offscreen document: runs the model and plays the audio (a service worker can
// do neither). Speaks one job at a time: normalizes the text with a map back to
// the source, chunks it, then generates a little ahead of playback, reporting
// each chunk's source range as it becomes audible so the page can highlight it.

import {
  aiNormalize,
  anthropicCall,
  chunkSpans,
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
let loading: Promise<Engine> | null = null;
let job: Job | null = null;
let token = 0;
let paused = false;
let state: PlayState = { status: "idle" };

const send = (m: ToBackground) => chrome.runtime.sendMessage(m).catch(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let idleTimer: ReturnType<typeof setTimeout> | undefined;

function setState(s: PlayState) {
  state = s;
  void send({ target: "background", type: "state", state: s });
  clearTimeout(idleTimer);
  if (s.status === "idle" || s.status === "error") {
    idleTimer = setTimeout(() => void send({ target: "background", type: "idle-timeout" }), IDLE_UNLOAD_MS);
  }
}

player.onClip = (c) => {
  if (!job) return;
  void send({ target: "background", type: "progress", jobId: job.id, ...c });
  if (state.status === "speaking") setState({ ...state, index: c.index, total: c.total });
};

async function getEngine(device: Device): Promise<Engine> {
  if (engine && engineDevice === device) return engine;
  if (!loading) {
    loading = (async () => {
      await engine?.release();
      engine = null;
      const r = await loadPreferred(device);
      engine = r.engine;
      engineDevice = device;
      engineNote = r.note;
      return r.engine;
    })().finally(() => (loading = null));
  }
  return loading;
}

/** The GPU failed mid-run (e.g. device lost after sleep): reload on the CPU. */
async function fallBackToWasm(err: unknown): Promise<Engine> {
  console.warn("[kokoro] WebGPU failed mid-run, switching to WASM:", err);
  await engine?.release().catch(() => {});
  engine = await loadEngine("wasm");
  engineNote = `GPU failed (${errText(err)}); using CPU.`;
  return engine;
}

async function speak(j: Job) {
  const my = ++token;
  job = j;
  player.stop();
  paused = false;
  try {
    const s = j.settings;
    // Chunk the offline normalization, so sentence breaks fall where they do
    // when spoken, and map each chunk back to the text it came from.
    const mt = normalizeMapped(j.text, s.normMode, s);
    const chunks = chunkSpans(mt.text).map((c, index) => ({ index, text: c.text, src: mt.source(c.start, c.end) }));
    if (!chunks.length) {
      finish(my);
      return;
    }
    if (!engine || engineDevice !== s.device) setState({ status: "loading", jobId: j.id });
    let e = await getEngine(s.device);
    if (my !== token) return;

    const ai = s.normMode === "ai";
    const note = j.note ?? (ai && !j.apiKey ? "AI rewriting needs an API key (Options); using built-in rules." : engineNote);
    setState({ status: paused ? "paused" : "speaking", jobId: j.id, backend: backendLabel(e.backend), message: note, needsAccess: j.needsAccess, index: 0, total: chunks.length });

    for (const c of chunks) {
      while (player.bufferedSec() > LOOKAHEAD_SEC && my === token) await sleep(200);
      if (my !== token) return;
      // Settings can change mid-job (voice, speed); later chunks pick them up.
      const cur = job!.settings;
      const call = ai && job!.apiKey ? anthropicCall({ apiKey: job!.apiKey, model: cur.model, timeoutMs: cur.timeoutMs }) : null;
      const text = call ? await aiNormalize(preNormalize(j.text.slice(...c.src), cur), cur.rules, call) : c.text;
      if (my !== token) return;
      let audio: Float32Array;
      try {
        audio = await e.generate(text, cur.voice, cur.speed);
      } catch (err) {
        if (e.backend !== "webgpu") throw err;
        e = await fallBackToWasm(err);
        if (my !== token) return;
        setState({ ...state, backend: backendLabel(e.backend), message: engineNote });
        audio = await e.generate(text, cur.voice, cur.speed);
      }
      if (my !== token) return;
      player.enqueue(audio, { index: c.index, total: chunks.length, start: c.src[0], end: c.src[1] });
    }
    await player.drained();
    finish(my);
  } catch (err) {
    if (my !== token) return;
    console.error("[kokoro]", err);
    player.stop();
    setState({ status: "error", message: `Couldn't speak: ${errText(err)}` });
    void send({ target: "background", type: "done", jobId: j.id });
  }
}

function finish(my: number) {
  if (my !== token || !job) return;
  void send({ target: "background", type: "done", jobId: job.id });
  job = null;
  setState({ status: "idle", backend: engine ? backendLabel(engine.backend) : undefined });
}

chrome.runtime.onMessage.addListener((m: ToOffscreen) => {
  if (m.target !== "offscreen") return;
  switch (m.type) {
    case "speak":
      void speak(m.job);
      break;
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
      setState({ ...state, status: state.status === "paused" ? "speaking" : state.status });
      break;
    case "stop":
      token++;
      job = null;
      player.stop();
      setState({ status: "idle", backend: engine ? backendLabel(engine.backend) : undefined });
      break;
    case "settings":
      if (job) job = { ...job, settings: m.settings, apiKey: m.apiKey };
      break;
  }
});

void send({ target: "background", type: "offscreen-ready" });
