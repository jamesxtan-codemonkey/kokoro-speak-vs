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

// ---- state ------------------------------------------------------------------

async function getState(): Promise<PlayState> {
  return ((await chrome.storage.session.get("state")).state as PlayState) ?? { status: "idle" };
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
  await chrome.storage.session.set({ state: s });
  // Errors are a passing message, not a mode: clear the badge and popup soon.
  clearTimeout(errorTimer);
  if (s.status === "error") {
    // (Longer when it offers to allow access, so there's time to open the popup.)
    errorTimer = setTimeout(async () => {
      if ((await getState()).status === "error") await setState({ status: "idle", backend: s.backend });
    }, s.needsAccess ? 120000 : 10000);
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
let markReady: (() => void) | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= (async () => {
    const ready = new Promise<void>((r) => (markReady = r));
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      // WORKERS too: with AUDIO_PLAYBACK alone, Chrome closes the document
      // ~30 s after audio stops, unloading the model between uses.
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.WORKERS],
      justification: "Runs the Kokoro speech model (WebGPU, or WASM worker threads) and plays its audio.",
    });
    await ready;
  })().finally(() => (creating = null));
  await creating;
}

function toOffscreen(m: ToOffscreen) {
  return chrome.runtime.sendMessage(m);
}

// ---- reading text out of the page ---------------------------------------------

/** Text from the page, null if there's none, or "restricted" if Chrome doesn't
 *  let extensions into the page (chrome:// pages, the Web Store, the PDF viewer). */
async function extract(
  tabId: number,
  mode: "selection" | "page",
  frameId?: number
): Promise<(Extracted & { frameId: number }) | { blocked: string } | null | "restricted"> {
  const target: chrome.scripting.InjectionTarget =
    frameId !== undefined ? { tabId, frameIds: [frameId] } : mode === "selection" ? { tabId, allFrames: true } : { tabId };
  try {
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target, css: HIGHLIGHT_CSS });
    const results = await chrome.scripting.executeScript({
      target,
      func: (m: "selection" | "page") => window.__kokoroSpeak?.extract(m) ?? null,
      args: [mode],
    });
    let blocked: string | undefined;
    for (const r of results) {
      const res = r.result as Extracted | null;
      if (res?.text.trim()) return { ...res, frameId: r.frameId };
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

async function clearHighlight(job: JobInfo | undefined) {
  if (!job?.mapped) return;
  const m: ToContent = { type: "kokoro:clear" };
  await chrome.tabs.sendMessage(job.tabId, m, { frameId: job.frameId }).catch(() => {});
}

async function startJob(tabId: number, frameId: number, text: string, mapped: boolean, extra: { note?: string; needsAccess?: string } = {}) {
  const prev = await getJob();
  await clearHighlight(prev);
  const id = (prev?.id ?? 0) + 1;
  const job: JobInfo = { id, tabId, frameId, mapped };
  await chrome.storage.session.set({ job });
  await setState({ status: "loading", jobId: id });
  const [settings, apiKey] = await Promise.all([loadSettings(), loadApiKey()]);
  await ensureOffscreen();
  await toOffscreen({ target: "offscreen", type: "speak", job: { id, text, settings, apiKey, ...extra } });
}

async function speakSelection(tabId: number, opts: { frameId?: number; frameUrl?: string; fallbackText?: string } = {}) {
  const got = await extract(tabId, "selection", opts.frameId);
  if (got && typeof got === "object" && "text" in got) return startJob(tabId, got.frameId, got.text, got.mapped);
  // A frame we can't read: from the right-click menu, Chrome still hands us the
  // selected text, so speak it, just without highlighting.
  const frame = got && typeof got === "object" ? got.blocked : got === "restricted" && opts.frameId ? webOrigin(opts.frameUrl) : undefined;
  if (opts.fallbackText?.trim()) {
    const note = frame ? `To highlight text in ${accessRequest(frame).label} frames, allow access from the toolbar popup.` : undefined;
    return startJob(tabId, opts.frameId ?? 0, opts.fallbackText, false, { note, needsAccess: frame });
  }
  if (frame) {
    return setState({
      status: "error",
      message: `The selected text is in an embedded frame from ${accessRequest(frame).label}. Allow access to read it, or right-click it and choose Speak selection.`,
      needsAccess: frame,
    });
  }
  await setState({ status: "error", message: got === "restricted" ? RESTRICTED : "Select some text on the page first." });
}

async function readPage(tabId: number) {
  const got = await extract(tabId, "page");
  if (got && typeof got === "object" && "text" in got) return startJob(tabId, got.frameId, got.text, got.mapped);
  await setState({ status: "error", message: got === "restricted" ? RESTRICTED : "Couldn't find text to read on this page." });
}

async function togglePause() {
  const s = await getState();
  if (!(await hasOffscreen())) return;
  if (s.status === "speaking" || s.status === "loading") await toOffscreen({ target: "offscreen", type: "pause" });
  else if (s.status === "paused") await toOffscreen({ target: "offscreen", type: "resume" });
}

async function stop() {
  await clearHighlight(await getJob());
  if (await hasOffscreen()) await toOffscreen({ target: "offscreen", type: "stop" });
  else await setState({ status: "idle" });
}

// ---- events -------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.speak, title: "Speak selection", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU.read, title: "Read this page aloud", contexts: ["page"] });
    chrome.contextMenus.create({ id: MENU.pause, title: "Pause speaking", contexts: ["all"], visible: false });
    chrome.contextMenus.create({ id: MENU.stop, title: "Stop speaking", contexts: ["all"], visible: false });
  });
  void setState({ status: "idle" });
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

chrome.runtime.onMessage.addListener((m: ToBackground, _sender, reply) => {
  if (m.target !== "background") return;
  const done = (p: Promise<unknown>) => {
    p.catch((e) => console.error("[kokoro]", e)).finally(() => reply(true));
    return true; // reply asynchronously
  };
  switch (m.type) {
    case "speak-selection":
      return done(speakSelection(m.tabId));
    case "read-page":
      return done(readPage(m.tabId));
    case "pause-toggle":
      return done(togglePause());
    case "stop":
      return done(stop());
    case "offscreen-ready":
      markReady?.();
      return;
    case "state":
      return done(setState(m.state));
    case "progress":
      return done(onProgress(m.jobId, m.start, m.end));
    case "done":
      return done(getJob().then((j) => (j?.id === m.jobId ? clearHighlight(j) : undefined)));
    case "idle-timeout":
      // Nothing played for a while: close the document to free the model's memory.
      return done(chrome.offscreen.closeDocument().catch(() => {}));
  }
});

// Stop reading a page once its tab closes or navigates away (or reloads).
async function stopIfReading(tabId: number) {
  const [job, s] = await Promise.all([getJob(), getState()]);
  if (job?.tabId === tabId && job.mapped && s.status !== "idle" && s.status !== "error") await stop();
}
chrome.tabs.onRemoved.addListener((tabId) => void stopIfReading(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") void stopIfReading(tabId);
});

async function onProgress(jobId: number, start: number, end: number) {
  const [job, settings] = await Promise.all([getJob(), loadSettings()]);
  if (!job || job.id !== jobId || !job.mapped || !settings.highlight) return;
  const m: ToContent = { type: "kokoro:highlight", start, end, autoScroll: settings.autoScroll };
  await chrome.tabs.sendMessage(job.tabId, m, { frameId: job.frameId }).catch(() => {});
}

// Voice, speed and normalization changes apply to the rest of what's playing.
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if ((area !== "sync" && area !== "local") || !(await hasOffscreen())) return;
  const [settings, apiKey] = await Promise.all([loadSettings(), loadApiKey()]);
  if (!settings.highlight) await clearHighlight(await getJob());
  await toOffscreen({ target: "offscreen", type: "settings", settings, apiKey }).catch(() => {});
});

// Test hooks for chrome/test/e2e.mjs, which can't click the toolbar or menus.
Object.assign(globalThis, { kokoro: { speakSelection, readPage, togglePause, stop, getState } });
