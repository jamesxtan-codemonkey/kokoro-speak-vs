// User settings: chrome.storage.sync (follows the user's Chrome profile), except
// the API key, which stays in chrome.storage.local on this device.

import { DEFAULT_VOICE, Voice, VOICES, describeVoice } from "../../src/core/voices";
import { NormMode, Replacement, SEED_RULES } from "../../src/core/normalize";

/** Where the model runs: WebGPU when available, else WASM (CPU). */
export type Device = "auto" | "webgpu" | "wasm";

export interface Settings {
  voice: Voice;
  speed: number;
  device: Device;
  highlight: boolean;
  autoScroll: boolean;
  normMode: NormMode;
  replacements: Replacement[];
  spellOut: string[];
  rules: string;
  model: string;
  timeoutMs: number;
}

export const DEFAULTS: Settings = {
  voice: DEFAULT_VOICE,
  speed: 1,
  device: "auto",
  highlight: true,
  autoScroll: true,
  normMode: "deterministic",
  replacements: [],
  spellOut: [],
  rules: SEED_RULES,
  // Same default as the VS Code extension's kokoroSpeak.normalization.model.
  model: "claude-haiku-4-5",
  timeoutMs: 20000,
};

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULTS, ...((await chrome.storage.sync.get(DEFAULTS)) as Partial<Settings>) };
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.sync.set(patch);
}

export async function loadApiKey(): Promise<string> {
  return ((await chrome.storage.local.get({ apiKey: "" })) as { apiKey: string }).apiKey;
}

export function saveApiKey(apiKey: string): Promise<void> {
  return chrome.storage.local.set({ apiKey });
}

/** "Heart — American female" for af_heart. */
export function voiceLabel(v: string): string {
  const name = v.slice(3);
  return `${name[0].toUpperCase()}${name.slice(1)} — ${describeVoice(v)}`;
}

/** Voices grouped for a <select>: [group label, voices]. */
export function voiceGroups(): Array<[string, Voice[]]> {
  const groups = new Map<string, Voice[]>();
  for (const v of VOICES) {
    const g = describeVoice(v).replace(/^./, (c) => c.toUpperCase());
    groups.set(g, [...(groups.get(g) ?? []), v]);
  }
  return [...groups];
}
