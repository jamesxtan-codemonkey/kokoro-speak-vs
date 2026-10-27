// Exercise cancellation/settings with controlled inference and API promises.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const stubs = {
  "./engine": `
    export const loadPreferred = (d) => harness.loadPreferred(d);
    export const loadEngine = (d) => harness.loadEngine(d);
    export const backendLabel = (b) => b;
    export const errText = (e) => String(e);
  `,
  "./player": `
    export class Player {
      onClip = () => {};
      constructor() { harness.player = this; }
      stop() {} pause() {} resume() {}
      bufferedSec() { return 0; }
      drained() { return Promise.resolve(); }
      enqueue(audio, info) { harness.clips.push(info); this.onClip(info); }
    }
  `,
  "@anthropic-ai/sdk": `
    export default class Anthropic {
      constructor(options) {
        this.messages = { create: (body, request) => harness.ai(body, request, options) };
      }
    }
  `,
};
const code = (await build({
  entryPoints: ["chrome/src/offscreen/offscreen.ts"], bundle: true, platform: "browser", format: "iife", write: false,
  plugins: [{ name: "controlled-inference", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => a.path in stubs ? { path: a.path, namespace: "test" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "test" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
})).outputFiles[0].text;
const SETTINGS = { voice: "af_heart", speed: 1, device: "auto", normMode: "deterministic", replacements: [], spellOut: [], rules: "Keep the words.", model: "test", timeoutMs: 20000 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
async function until(f) {
  for (let i = 0; i < 100; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail("condition did not become true");
}

function offscreen(t) {
  const timers = new Set();
  const h = { sent: [], generated: [], clips: [], requests: [], loads: [], released: [], fallbacks: [] };
  const engine = (backend) => ({
    backend,
    async generate(text) { h.generated.push(text); return h.generate ? h.generate(text) : new Float32Array(24); },
    async release() { h.released.push(backend); },
  });
  h.loadPreferred = async (d) => { h.loads.push(d); return { engine: engine(d === "wasm" ? "wasm" : "webgpu") }; };
  h.loadEngine = async (d) => { h.fallbacks.push(d); return engine(d); };
  h.ai = async (body, request, options) => {
    h.requests.push({ body, request, options });
    return { stop_reason: "end_turn", content: [{ type: "text", text: body.messages[0].content.split("\n").slice(1).join("\n") }] };
  };
  let listener;
  const chrome = { runtime: {
    id: "test", getURL: (p) => `chrome-extension://test/${p}`,
    async sendMessage(m) { h.sent.push(m); },
    onMessage: { addListener(f) { listener = f; } },
  } };
  runInNewContext(code, {
    chrome, harness: h, AbortController, console,
    setTimeout(f, ms) { const timer = setTimeout(f, ms === 200 ? 2 : ms); timer.unref(); timers.add(timer); return timer; }, clearTimeout,
  });
  h.message = (m, sender = { id: "test", url: chrome.runtime.getURL("background.js") }) => listener({ target: "offscreen", ...m }, sender, () => {});
  h.start = (id, text, settings = {}) => h.message({ type: "speak", job: { id, text, settings: { ...SETTINGS, ...settings }, apiKey: "test-key" } });
  h.state = () => h.sent.filter((m) => m.type === "state").at(-1).state;
  t.after(() => { h.message({ type: "stop" }); for (const timer of timers) clearTimeout(timer); });
  return h;
}

test("Chrome: new jobs wait for in-flight inference before releasing its engine", async (t) => {
  const h = offscreen(t);
  const gate = deferred();
  h.generate = () => gate.promise;
  h.start(1, "First job.");
  await until(() => h.generated.length === 1);
  h.start(2, "Second job.", { device: "wasm" });
  assert.deepEqual(h.loads, ["auto"]);
  assert.deepEqual(h.released, []);
  h.generate = undefined;
  gate.resolve(new Float32Array(24));
  await until(() => h.state().status === "idle");
  assert.deepEqual(h.loads, ["auto", "wasm"]);
  assert.deepEqual(h.released, ["webgpu"]);
  assert.equal(h.clips.length, 1, "cancelled audio must not enqueue");
  assert.equal(h.state().jobId, 2);
});

test("Chrome: cancelled GPU failures do not reload or downgrade the next job", async (t) => {
  const h = offscreen(t);
  const gate = deferred();
  h.generate = () => gate.promise;
  h.start(1, "First job.");
  await until(() => h.generated.length === 1);
  h.start(2, "Second job.");
  h.generate = undefined;
  gate.reject(new Error("device lost"));
  await until(() => h.state().status === "idle");
  assert.deepEqual(h.fallbacks, []);
  assert.equal(h.clips.length, 1);
});

test("Chrome: pause during model loading holds synthesis until resume", async (t) => {
  const h = offscreen(t);
  const gate = deferred();
  const load = h.loadPreferred;
  h.loadPreferred = async (d) => { await gate.promise; return load(d); };
  h.start(1, "A paused sentence.");
  h.message({ type: "pause" });
  gate.resolve();
  await until(() => h.loads.length === 1);
  assert.equal(h.state().status, "paused");
  assert.equal(h.generated.length, 0);
  h.message({ type: "resume" });
  await until(() => h.state().status === "idle");
  assert.equal(h.generated.length, 1);
});

test("Chrome: switching AI off stops subsequent API calls and applies Off", async (t) => {
  const h = offscreen(t);
  const gate = deferred();
  h.generate = () => gate.promise;
  h.start(1, "I paid $1. Then I paid $2.", { normMode: "ai" });
  await until(() => h.generated.length === 1);
  h.message({ type: "settings", settings: { ...SETTINGS, normMode: "off" }, apiKey: "test-key" });
  h.generate = undefined;
  gate.resolve(new Float32Array(24));
  await until(() => h.state().status === "idle");
  assert.equal(h.requests.length, 1);
  assert.equal(h.generated.at(-1), "Then I paid $2.");
});

test("Chrome: Stop aborts an AI request without synthesizing its result", async (t) => {
  const h = offscreen(t);
  let signal;
  h.ai = (_body, request) => new Promise((_resolve, reject) => {
    signal = request.signal;
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  h.start(1, "I paid $1.", { normMode: "ai" });
  await until(() => signal);
  h.message({ type: "stop" });
  assert.equal(signal.aborted, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.generated.length, 0);
  assert.equal(h.state().status, "idle");
});

test("Chrome: mapped replacements spanning chunks do not repeat the source in AI mode", async (t) => {
  const h = offscreen(t);
  const lines = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1} has six plain words.`);
  h.start(1, `**${lines.join(" ")}**`, { normMode: "ai" });
  await until(() => h.state().status === "idle");
  assert.equal(h.generated.join(" "), lines.join(" "));
  assert.equal(h.requests.length, lines.length);
  for (const r of h.requests) assert.ok(r.body.messages[0].content.length < 100);
});

test("Chrome: expanded AI output is rechunked before inference", async (t) => {
  const h = offscreen(t);
  const expanded = "one two three four five six ".repeat(60).trim() + ".";
  h.ai = async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: expanded }] });
  h.start(1, "I paid $1.", { normMode: "ai" });
  await until(() => h.state().status === "idle");
  assert.ok(h.generated.length > 1);
  assert.ok(h.generated.every((s) => s.length <= 250));
  assert.equal(h.generated.join(" "), expanded);
});

test("Chrome: offscreen rejects content-script control messages", async (t) => {
  const h = offscreen(t);
  h.message({ type: "speak", job: { id: 1, text: "Untrusted.", settings: SETTINGS } }, { id: "test", url: "https://example.com/", tab: { id: 1 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.loads.length, 0);
});
