// Toolbar popup: start/pause/stop, voice and speed. Playback runs in the
// offscreen document, so it carries on after the popup closes.

import { accessRequest } from "./access";
import type { PlayState, ToBackground } from "./messages";
import { loadSettings, saveSettings, voiceGroups, voiceLabel } from "./settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (m: ToBackground) => chrome.runtime.sendMessage(m);

const STATUS: Record<PlayState["status"], string> = {
  idle: "Ready",
  loading: "Loading the voice model…",
  speaking: "Speaking",
  paused: "Paused",
  error: "Couldn't speak",
};

function render(s: PlayState) {
  const progress = s.status === "speaking" && s.total && s.total > 1 ? ` (${(s.index ?? 0) + 1} of ${s.total})` : "";
  const error = s.status === "error";
  $("status").textContent = error && s.message ? s.message : STATUS[s.status] + progress;
  $("status").classList.toggle("error", error);
  const note = $("note");
  note.textContent = error ? "" : s.message ?? "";
  note.hidden = !note.textContent;
  const active = s.status === "loading" || s.status === "speaking" || s.status === "paused";
  $<HTMLButtonElement>("pause").disabled = !active;
  $<HTMLButtonElement>("stop").disabled = !active;
  $("pause").firstChild!.textContent = s.status === "paused" ? "Resume" : "Pause";
  $("backend").textContent = s.backend ? `Running on ${s.backend}` : "";
  const allow = $<HTMLButtonElement>("allow");
  allow.hidden = !s.needsAccess;
  if (s.needsAccess) {
    const req = accessRequest(s.needsAccess);
    allow.textContent = `Allow reading ${req.label}`;
    allow.dataset.pattern = req.pattern;
  }
}

async function activeTabId(): Promise<number | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
}

async function init() {
  const settings = await loadSettings();
  const voice = $<HTMLSelectElement>("voice");
  for (const [group, voices] of voiceGroups()) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const v of voices) og.append(new Option(voiceLabel(v).split(" — ")[0], v));
    voice.append(og);
  }
  voice.value = settings.voice;
  voice.onchange = () => saveSettings({ voice: voice.value as any });

  const speed = $<HTMLInputElement>("speed");
  const out = $("speed-out");
  const showSpeed = () => (out.textContent = `${Number(speed.value).toFixed(2).replace(/0$/, "")}×`);
  speed.value = String(settings.speed);
  showSpeed();
  speed.oninput = showSpeed;
  speed.onchange = () => saveSettings({ speed: Number(speed.value) });

  for (const c of await chrome.commands.getAll()) {
    const kbd = document.querySelector(`kbd[data-command="${c.name}"]`);
    if (kbd) kbd.textContent = c.shortcut ?? "";
  }

  $("speak").onclick = async () => {
    const tabId = await activeTabId();
    if (tabId !== undefined) await send({ target: "background", type: "speak-selection", tabId });
  };
  $("read").onclick = async () => {
    const tabId = await activeTabId();
    if (tabId !== undefined) await send({ target: "background", type: "read-page", tabId });
  };
  // Text in another site's embedded frame: ask for that one site, then read it.
  $("allow").onclick = async () => {
    const pattern = $("allow").dataset.pattern;
    if (!pattern || !(await chrome.permissions.request({ origins: [pattern] }))) return;
    const tabId = await activeTabId();
    if (tabId !== undefined) await send({ target: "background", type: "speak-selection", tabId });
  };
  $("pause").onclick = () => send({ target: "background", type: "pause-toggle" });
  $("stop").onclick = () => send({ target: "background", type: "stop" });
  $("options").onclick = (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  };

  render(((await chrome.storage.session.get("state")).state as PlayState) ?? { status: "idle" });
  chrome.storage.session.onChanged.addListener((c) => {
    if (c.state?.newValue) render(c.state.newValue as PlayState);
  });
}

void init();
