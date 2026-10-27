// Service-worker lifecycle tests without Chrome or the speech model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const code = (await build({ entryPoints: ["chrome/src/background.ts"], bundle: true, platform: "browser", format: "iife", write: false })).outputFiles[0].text;
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function until(f) {
  for (let i = 0; i < 100; i++) {
    if (f()) return;
    await tick();
  }
  assert.fail("condition did not become true");
}

async function worker(t, initial = {}) {
  const event = () => ({ listeners: [], addListener(f) { this.listeners.push(f); } });
  const h = { data: {}, sent: [], highlights: [], access: [], open: false, created: 0, closed: 0, live: { status: "idle" }, ...initial };
  const timers = new Set();
  const area = (data, name) => ({
    async get(keys) {
      if (typeof keys === "string") return structuredClone({ [keys]: data[keys] });
      if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map((k) => [k, data[k]])));
      return structuredClone({ ...keys, ...data });
    },
    async set(patch) { Object.assign(data, structuredClone(patch)); },
    async remove(key) { delete data[key]; },
    async setAccessLevel(o) { h.access.push([name, o.accessLevel]); },
  });
  const chrome = {
    runtime: {
      id: "test", getURL: (p) => `chrome-extension://test/${p}`, ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      onMessage: event(), onInstalled: event(),
      async getContexts() { return h.open ? [{}] : []; },
      async sendMessage(m) {
        if (m.type === "get-state") return h.open ? h.live : undefined;
        h.sent.push(m);
        if (m.type === "speak") h.live = { status: m.job.paused ? "paused" : "speaking", jobId: m.job.id };
        if (m.type === "stop") h.live = { status: "idle", jobId: h.live.jobId };
        return true;
      },
    },
    storage: { session: area(h.data, "session"), local: area({}, "local"), sync: area({}, "sync"), onChanged: event() },
    offscreen: {
      Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK", WORKERS: "WORKERS" },
      async createDocument() { h.created++; h.open = true; await h.create?.(); },
      async closeDocument() { h.closed++; h.open = false; },
    },
    scripting: {
      async executeScript(o) { return o.files ? [] : [{ frameId: 0, documentId: "document-1", result: await (h.extract?.(o.target.tabId) ?? { text: "Some text.", mapped: true }) }]; },
      async insertCSS() {},
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    contextMenus: { onClicked: event(), async update() {}, removeAll(f) { f(); }, create() {} },
    commands: { onCommand: event() },
    tabs: { onRemoved: event(), onUpdated: event(), async query() { return []; }, async sendMessage(...args) { h.highlights.push(args); } },
  };
  const ctx = { chrome, console, URL, clearTimeout, setTimeout(f, ms) { const timer = setTimeout(f, ms); timer.unref(); timers.add(timer); return timer; } };
  runInNewContext(code, ctx);
  h.api = ctx.kokoro;
  h.chrome = chrome;
  h.message = (m, sender = { id: "test", url: chrome.runtime.getURL("offscreen.html") }) => new Promise((resolve) => {
    if (chrome.runtime.onMessage.listeners[0]({ target: "background", ...m }, sender, resolve) !== true) resolve();
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  await tick();
  return h;
}

test("Chrome: Stop cancels a start waiting for the offscreen document", async (t) => {
  const gate = deferred();
  const h = await worker(t, { create: () => gate.promise });
  const start = h.api.readPage(1);
  await until(() => h.created === 1);
  await h.api.stop();
  gate.resolve();
  await start;
  assert.equal(h.sent.filter((m) => m.type === "speak").length, 0);
  assert.equal((await h.api.getState()).status, "idle");
});

test("Chrome: Pause during document creation is carried into the new job", async (t) => {
  const gate = deferred();
  const h = await worker(t, { create: () => gate.promise });
  const start = h.api.readPage(1);
  await until(() => h.created === 1);
  await h.api.togglePause();
  gate.resolve();
  await start;
  assert.equal(h.sent.find((m) => m.type === "speak").job.paused, true);
});

test("Chrome: overlapping starts share creation and only the newest starts", async (t) => {
  const gate = deferred();
  const h = await worker(t, { create: () => gate.promise });
  const first = h.api.readPage(1);
  await until(() => h.created === 1);
  const second = h.api.readPage(2);
  await until(() => h.data.job?.tabId === 2);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(h.created, 1);
  const jobs = h.sent.filter((m) => m.type === "speak");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.id, h.data.job.id);
  await h.message({ type: "state", state: { status: "idle", jobId: jobs[0].job.id - 1 } });
  assert.equal(h.data.state.status, "loading", "old completion must not overwrite the new job");
  await h.message({ type: "idle-timeout" });
  assert.equal(h.closed, 0, "an idle timer must not close a newly active document");
});

test("Chrome: worker restart reconciles missing documents and surviving playback", async (t) => {
  const job = { id: 42, tabId: 1, frameId: 0, mapped: true, started: true };
  const state = { status: "speaking", jobId: 42 };
  const missing = await worker(t, { data: { job, state } });
  assert.equal(missing.data.state.status, "idle");
  assert.equal(missing.data.job, undefined);
  const live = await worker(t, { open: true, data: { job, state }, live: { status: "paused", jobId: 42 } });
  assert.equal(live.data.state.status, "paused");
  await live.api.stop();
  await live.message({ type: "state", state });
  assert.equal(live.data.state.status, "idle");
});

test("Chrome: closed tabs cancel pending extraction and unmapped jobs", async (t) => {
  const gate = deferred();
  const h = await worker(t, { extract: () => gate.promise });
  const start = h.api.readPage(1);
  await until(() => h.data.job);
  h.chrome.tabs.onRemoved.listeners[0](1);
  await tick();
  gate.resolve({ text: "Input text.", mapped: false });
  await start;
  assert.equal(h.sent.some((m) => m.type === "speak"), false);
  h.extract = () => ({ text: "Input text.", mapped: false });
  await h.api.readPage(2);
  h.chrome.tabs.onRemoved.listeners[0](2);
  await tick();
  assert.equal(h.data.state.status, "idle");
});

test("Chrome: offscreen creation failure reaches the popup", async (t) => {
  const h = await worker(t, { create: () => { throw new Error("creation failed"); } });
  await h.api.readPage(1);
  assert.equal(h.data.state.status, "error");
  assert.match(h.data.state.message, /creation failed/);
});

test("Chrome: reject content-script commands and protect stored credentials/settings", async (t) => {
  const h = await worker(t);
  const sender = { id: "test", url: "https://example.com/", tab: { id: 1 } };
  await h.message({ type: "read-page", tabId: 2 }, sender);
  await h.message({ type: "state", state: { status: "speaking" } }, sender);
  await h.message({ type: "idle-timeout" }, sender);
  assert.equal(h.created, 0);
  assert.equal(h.data.state.status, "idle");
  assert.deepEqual(h.access, [["local", "TRUSTED_CONTEXTS"], ["sync", "TRUSTED_CONTEXTS"]]);
});

test("Chrome: expired errors clear after worker suspension", async (t) => {
  const h = await worker(t, { data: { state: { status: "error", expiresAt: Date.now() - 1 } } });
  assert.equal((await h.api.getState()).status, "idle");
});

test("Chrome: highlights target the extracted document and release its map", async (t) => {
  const h = await worker(t);
  await h.api.readPage(1);
  const id = h.data.job.id;
  await h.message({ type: "progress", jobId: id, start: 0, end: 4 });
  assert.equal(h.highlights.at(-1)[2].documentId, "document-1");
  await h.api.stop();
  assert.equal(h.highlights.at(-1)[1].release, true);
});

test("Chrome: frame unload can stop only the document being read", async (t) => {
  const h = await worker(t);
  await h.api.readPage(1);
  const sender = { id: "test", url: "https://example.com/", tab: { id: 1 }, documentId: "other-document" };
  await h.message({ type: "page-hidden" }, sender);
  assert.ok(h.data.job);
  await h.message({ type: "page-hidden" }, { ...sender, documentId: "document-1" });
  assert.equal(h.data.job, undefined);
  assert.equal(h.data.state.status, "idle");
});

test("Chrome: cancelled extraction releases only its own DOM map", async (t) => {
  const gate = deferred();
  const h = await worker(t, { extract: () => gate.promise });
  const start = h.api.readPage(1);
  await until(() => h.data.job);
  const id = h.data.job.id;
  await h.api.stop();
  gate.resolve({ text: "Old selected text.", mapped: true });
  await start;
  assert.equal(h.highlights.at(-1)[1].jobId, id);
  assert.equal(h.highlights.at(-1)[1].release, true);
});
