// Service worker: the right-click menu, keyboard shortcuts and popup requests
// come in here. It reads the text out of the page (via the content script),
// hands it to the offscreen document to speak, relays which range is being
// spoken back to the page for highlighting, and keeps the playback state that
// the popup and toolbar badge show. It can be stopped whenever it's idle, so
// that state lives in chrome.storage.session, not in variables.

import { accessRequest } from "./access";
import type { Extracted, JobInfo, PlayState, ToBackground, ToContent, ToOffscreen } from "./messages";
import { loadApiKey, loadSettings } from "./settings";

const MENU = {
  speak: "kokoro-speak-selection",
  read: "kokoro-read-page",
  pause: "kokoro-pause",
  stop: "kokoro-stop",
} as const;

const HIGHLIGHT_CSS = "::highlight(kokoro-speak) { background-color: rgba(255, 196, 0, 0.45); color: inherit; }";

// Content scripts need neither settings nor the API key. (Best effort: a Chrome
// that can't restrict these areas must still be able to read pages.)
const storageReady = Promise.all(
  [chrome.storage.local, chrome.storage.sync].map((area) =>
    area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch((e) => console.warn("[kokoro] storage access level:", e))
  )
);

// Serialize short state transitions, but let Stop interrupt extraction/loading.
let pending = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const p = pending.then(f);
  pending = p.then(() => {}, (e) => console.error("[kokoro]", e));
  return p;
}

// ---- state ------------------------------------------------------------------

async function getState(): Promise<PlayState> {
  const s = ((await chrome.storage.session.get("state")).state as PlayState) ?? { status: "idle" };
  if (s.status === "error" && s.expiresAt && s.expiresAt <= Date.now()) {
    const idle: PlayState = { status: "idle", backend: s.backend };
    await setState(idle);
    return idle;
  }
  return s;
}

async function getJob(): Promise<JobInfo | undefined> {
  return (await chrome.storage.session.get("job")).job as JobInfo | undefined;
}

const BADGE: Record<PlayState["status"], [string, string]> = {
  idle: ["", "#000000"],
  loading: ["…", "#5f6368"],
  speaking: ["▶", "#1a73e8"],
  paused: ["II", "#5f6368"],
  error: ["!", "#d93025"],
};

let errorTimer: ReturnType<typeof setTimeout> | undefined;

async function setState(s: PlayState) {
  if (s.status === "error") s = { ...s, expiresAt: s.expiresAt ?? Date.now() + (s.needsAccess ? 120000 : 10000) };
  await chrome.storage.session.set({ state: s });
  // Errors are a passing message, not a mode: clear the badge and popup soon.
  clearTimeout(errorTimer);
  if (s.status === "error") {
    // (Longer when it offers to allow access, so there's time to open the popup.)
    errorTimer = setTimeout(() => void serial(getState), Math.max(0, s.expiresAt! - Date.now()));
  }
  const [text, color] = BADGE[s.status];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  const active = s.status === "loading" || s.status === "speaking" || s.status === "paused";
  await chrome.contextMenus.update(MENU.pause, { visible: active, title: s.status === "paused" ? "Resume speaking" : "Pause speaking" }).catch(() => {});
  await chrome.contextMenus.update(MENU.stop, { visible: active }).catch(() => {});
}

// ---- offscreen document -------------------------------------------------------

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  creating ??= (async () => {
    if (!(await hasOffscreen())) await chrome.offscreen.createDocument({
      url: "offscreen.html",
      // WORKERS too: with AUDIO_PLAYBACK alone, Chrome closes the document
      // ~30 s after audio stops, unloading the model between uses.
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.WORKERS],
      justification: "Runs the Kokoro speech model (WebGPU, or WASM worker threads) and plays its audio.",
    });
    // Also works after a worker restart, when the one-shot ready event is gone.
    const until = Date.now() + 10000;
    do {
      const s = await toOffscreen({ target: "offscreen", type: "get-state" }).catch(() => null);
      if (s) return;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < until);
    await chrome.offscreen.closeDocument().catch(() => {});
    throw new Error("The audio document did not become ready.");
  })().finally(() => (creating = null));
  await creating;
}

function toOffscreen(m: ToOffscreen) {
  return chrome.runtime.sendMessage(m);
}

// ---- reading text out of the page ---------------------------------------------

/** Text from the page, null if there's none, or "restricted" if Chrome doesn't
 *  let extensions into the page (chrome:// pages, the Web Store, the PDF viewer). */
let extracting = Promise.resolve();
function extract(tabId: number, mode: "selection" | "page", jobId: number, frameId?: number) {
  const p = extracting.then(() => extractPage(tabId, mode, jobId, frameId));
  extracting = p.then(() => {}, () => {});
  return p;
}

async function extractPage(
  tabId: number,
  mode: "selection" | "page",
  jobId: number,
  frameId?: number
): Promise<(Extracted & { frameId: number; documentId?: string }) | { blocked: string } | null | "restricted"> {
  const target: chrome.scripting.InjectionTarget =
    frameId !== undefined ? { tabId, frameIds: [frameId] } : mode === "selection" ? { tabId, allFrames: true } : { tabId };
  try {
    await storageReady;
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target, css: HIGHLIGHT_CSS });
    const results = await chrome.scripting.executeScript({
      target,
      func: (m: "selection" | "page", id: number) => window.__kokoroSpeak?.extract(m, id) ?? null,
      args: [mode, jobId],
    });
    let blocked: string | undefined;
    for (const r of results) {
      const res = r.result as Extracted | null;
      if (res?.text.trim()) return { ...res, frameId: r.frameId, documentId: r.documentId };
      blocked ??= res?.frame;
    }
    // The selection is in another site's embedded frame, which we can't read
    // (activeTab covers the page's own site only) until the user allows it.
    if (blocked) return { blocked };
  } catch (e) {
    console.warn("[kokoro] can't read this page:", e);
    return "restricted";
  }
  return null;
}

const RESTRICTED = "Chrome doesn't let extensions read this page.";

/** An http(s) origin, or undefined (e.g. for chrome:// or the PDF viewer). */
function webOrigin(url: string | undefined): string | undefined {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

async function clearHighlight(job: JobInfo | undefined, release = true) {
  if (!job?.mapped) return;
  const m: ToContent = { type: "kokoro:clear", jobId: job.id, release };
  await chrome.tabs.sendMessage(job.tabId, m, { frameId: job.frameId, documentId: job.documentId }).catch(() => {});
}

async function beginJob(tabId: number): Promise<number> {
  return serial(async () => {
    const { sequence = 0 } = await chrome.storage.session.get("sequence") as { sequence?: number };
    const prev = await getJob();
    const id = Math.max(sequence, prev?.id ?? 0) + 1;
    await clearHighlight(prev);
    await chrome.storage.session.set({ sequence: id, job: { id, tabId, frameId: 0, mapped: false } });
    if (await hasOffscreen()) await toOffscreen({ target: "offscreen", type: "stop" }).catch(() => {});
    await setState({ status: "loading", jobId: id });
    return id;
  });
}

async function jobError(id: number, s: PlayState) {
  await serial(async () => {
    const j = await getJob();
    if (j?.id !== id) return;
    await clearHighlight(j);
    await chrome.storage.session.remove("job");
    await setState(s);
  });
}

async function startJob(id: number, tabId: number, frameId: number, text: string, mapped: boolean, extra: { note?: string; needsAccess?: string } = {}, documentId?: string) {
  const job: JobInfo = { id, tabId, frameId, documentId, mapped };
  const current = await serial(async () => {
    if ((await getJob())?.id !== id) {
      await clearHighlight(job);
      return false;
    }
    await chrome.storage.session.set({ job });
    return true;
  });
  if (!current) return;
  await ensureOffscreen();
  await serial(async () => {
    if ((await getJob())?.id !== id) return;
    const [settings, apiKey, s] = await Promise.all([loadSettings(), loadApiKey(), getState()]);
    await chrome.storage.session.set({ job: { ...job, started: true } });
    await toOffscreen({ target: "offscreen", type: "speak", job: { id, text, settings, apiKey, paused: s.status === "paused", ...extra } });
  });
}

async function speakSelection(tabId: number, opts: { frameId?: number; frameUrl?: string; fallbackText?: string } = {}) {
  const id = await beginJob(tabId);
  try {
    const got = await extract(tabId, "selection", id, opts.frameId);
    if (got && typeof got === "object" && "text" in got) return await startJob(id, tabId, got.frameId, got.text, got.mapped, {}, got.documentId);
    // A frame we can't read: from the right-click menu, Chrome still hands us the
    // selected text, so speak it, just without highlighting.
    const frame = got && typeof got === "object" ? got.blocked : got === "restricted" && opts.frameId ? webOrigin(opts.frameUrl) : undefined;
    if (opts.fallbackText?.trim()) {
      const note = frame ? `To highlight text in ${accessRequest(frame).label} frames, allow access from the toolbar popup.` : undefined;
      return await startJob(id, tabId, opts.frameId ?? 0, opts.fallbackText, false, { note, needsAccess: frame });
    }
    if (frame) {
      return await jobError(id, {
        status: "error",
        message: `The selected text is in an embedded frame from ${accessRequest(frame).label}. Allow access to read it, or right-click it and choose Speak selection.`,
        needsAccess: frame,
      });
    }
    await jobError(id, { status: "error", message: got === "restricted" ? RESTRICTED : "Select some text on the page first." });
  } catch (e) {
    await jobError(id, { status: "error", message: `Couldn't speak: ${String(e)}` });
  }
}

async function readPage(tabId: number) {
  const id = await beginJob(tabId);
  try {
    const got = await extract(tabId, "page", id);
    if (got && typeof got === "object" && "text" in got) return await startJob(id, tabId, got.frameId, got.text, got.mapped, {}, got.documentId);
    await jobError(id, { status: "error", message: got === "restricted" ? RESTRICTED : "Couldn't find text to read on this page." });
  } catch (e) {
    await jobError(id, { status: "error", message: `Couldn't speak: ${String(e)}` });
  }
}

async function togglePause() {
  await serial(async () => {
    const [s, j] = await Promise.all([getState(), getJob()]);
    if (!j || !["speaking", "loading", "paused"].includes(s.status)) return;
    const resume = s.status === "paused";
    await setState({ ...s, status: resume ? (j.started ? "speaking" : "loading") : "paused" });
    if (j.started && await hasOffscreen()) await toOffscreen({ target: "offscreen", type: resume ? "resume" : "pause" });
  });
}

async function stop(tabId?: number, documentId?: string) {
  await serial(async () => {
    const j = await getJob();
    if (tabId !== undefined && j?.tabId !== tabId) return;
    if (documentId !== undefined && j?.documentId !== documentId) return;
    await clearHighlight(j);
    await chrome.storage.session.remove("job");
    if (await hasOffscreen()) await toOffscreen({ target: "offscreen", type: "stop" }).catch(() => {});
    await setState({ status: "idle", backend: (await getState()).backend });
  });
}

// ---- events -------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.speak, title: "Speak selection", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU.read, title: "Read this page aloud", contexts: ["page"] });
    chrome.contextMenus.create({ id: MENU.pause, title: "Pause speaking", contexts: ["all"], visible: false });
    chrome.contextMenus.create({ id: MENU.stop, title: "Stop speaking", contexts: ["all"], visible: false });
  });
  void serial(() => setState({ status: "idle" }));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (info.menuItemId === MENU.speak && tabId !== undefined)
    void speakSelection(tabId, { frameId: info.frameId, frameUrl: info.frameUrl, fallbackText: info.selectionText });
  else if (info.menuItemId === MENU.read && tabId !== undefined) void readPage(tabId);
  else if (info.menuItemId === MENU.pause) void togglePause();
  else if (info.menuItemId === MENU.stop) void stop();
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (command === "speak-selection" && tabId !== undefined) void speakSelection(tabId);
  else if (command === "read-page" && tabId !== undefined) void readPage(tabId);
  else if (command === "pause-resume") void togglePause();
  else if (command === "stop") void stop();
});

chrome.runtime.onMessage.addListener((m: ToBackground, sender, reply) => {
  if (!m || m.target !== "background" || sender.id !== chrome.runtime.id) return;
  if (m.type === "page-hidden") {
    // A content script can only stop playback belonging to its own document.
    if (sender.tab?.id !== undefined && sender.documentId) {
      stop(sender.tab.id, sender.documentId).then(() => reply(true), () => reply(false));
      return true;
    }
    return;
  }
  const offscreen = !sender.tab && sender.url === chrome.runtime.getURL("offscreen.html");
  const ui = sender.url === chrome.runtime.getURL("popup.html") || sender.url === chrome.runtime.getURL("options.html");
  const report = ["offscreen-ready", "state", "progress", "done", "idle-timeout"].includes(m.type);
  if (report ? !offscreen : !ui) return;
  const done = (p: Promise<unknown>) => {
    p.catch((e) => console.error("[kokoro]", e)).finally(() => reply(true));
    return true; // reply asynchronously
  };
  switch (m.type) {
    case "get-state":
      serial(getState).then(reply, () => reply({ status: "idle" }));
      return true;
    case "speak-selection":
      if (!Number.isInteger(m.tabId) || m.tabId < 0) return;
      return done(speakSelection(m.tabId));
    case "read-page":
      if (!Number.isInteger(m.tabId) || m.tabId < 0) return;
      return done(readPage(m.tabId));
    case "pause-toggle":
      return done(togglePause());
    case "stop":
      return done(stop());
    case "offscreen-ready":
      return;
    case "state":
      return done(serial(async () => {
        const j = await getJob();
        if (!j?.started || j.id !== m.state.jobId) return;
        await setState(m.state);
        if (m.state.status === "idle" || m.state.status === "error") {
          await clearHighlight(j);
          await chrome.storage.session.remove("job");
        }
      }));
    case "progress":
      return done(serial(() => onProgress(m.jobId, m.start, m.end)));
    case "done":
      return done(serial(() => getJob().then((j) => (j?.id === m.jobId ? clearHighlight(j) : undefined))));
    case "idle-timeout":
      // Nothing played for a while: close the document to free the model's memory.
      return done(serial(async () => {
        if (creating || await getJob()) return;
        const s = await toOffscreen({ target: "offscreen", type: "get-state" }).catch(() => null) as PlayState | null;
        if (s && s.jobId === m.jobId && (s.status === "idle" || s.status === "error")) await chrome.offscreen.closeDocument().catch(() => {});
      }));
  }
});

// Stop reading a page once its tab closes or navigates away (or reloads).
chrome.tabs.onRemoved.addListener((tabId) => void stop(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") void stop(tabId);
});

async function onProgress(jobId: number, start: number, end: number) {
  const [job, settings] = await Promise.all([getJob(), loadSettings()]);
  if (!job || job.id !== jobId || !job.mapped || !settings.highlight) return;
  const m: ToContent = { type: "kokoro:highlight", jobId, start, end, autoScroll: settings.autoScroll };
  await chrome.tabs.sendMessage(job.tabId, m, { frameId: job.frameId, documentId: job.documentId }).catch(() => {});
}

// Voice, speed and normalization changes apply to the rest of what's playing.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "sync" && area !== "local") return;
  void serial(async () => {
    if (!(await hasOffscreen())) return;
    const [settings, apiKey] = await Promise.all([loadSettings(), loadApiKey()]);
    if (!settings.highlight) await clearHighlight(await getJob(), false);
    await toOffscreen({ target: "offscreen", type: "settings", settings, apiKey }).catch(() => {});
  });
});

// The worker can restart while the document survives, or after it was closed.
void serial(async () => {
  await storageReady;
  const [j, saved] = await Promise.all([getJob(), getState()]);
  const live = await hasOffscreen() ? await toOffscreen({ target: "offscreen", type: "get-state" }).catch(() => null) as PlayState | null : null;
  if (live && live.status !== "idle" && live.status !== "error" && live.jobId !== j?.id) {
    await toOffscreen({ target: "offscreen", type: "stop" }).catch(() => {});
  }
  if (j) {
    if (j.started && live?.jobId === j.id && live.status !== "idle" && live.status !== "error") return setState(live);
    await clearHighlight(j);
    await chrome.storage.session.remove("job");
    await setState(live?.jobId === j.id ? live : { status: "idle", backend: live?.backend ?? saved.backend });
  } else {
    await setState(saved.status === "idle" || saved.status === "error" ? saved : { status: "idle", backend: saved.backend });
  }
});

// Test hooks for chrome/test/e2e.mjs, which can't click the toolbar or menus.
Object.assign(globalThis, { kokoro: { speakSelection, readPage, togglePause, stop, getState } });
