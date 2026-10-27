// Messages between the extension's parts. The offscreen document only has
// chrome.runtime, so everything it needs (settings, the API key) arrives in
// messages, and everything it reports goes through the service worker.

import type { Settings } from "./settings";

export type Status = "idle" | "loading" | "speaking" | "paused" | "error";

/** Playback state, kept in chrome.storage.session for the popup and badge. */
export interface PlayState {
  status: Status;
  /** Shown under the status: an error, or a note such as a fallback. */
  message?: string;
  /** "GPU (WebGPU)" or "CPU (WASM)" once the model is loaded. */
  backend?: string;
  jobId?: number;
  index?: number;
  total?: number;
  /** An origin whose embedded frame holds the selection, which the extension
   *  needs permission to read; the popup offers to request it. */
  needsAccess?: string;
  expiresAt?: number;
}

/** The text being spoken and where its highlights go. */
export interface JobInfo {
  id: number;
  tabId: number;
  frameId: number;
  documentId?: string;
  started?: boolean;
  /** True when the text maps back to the page, so it can be highlighted. */
  mapped: boolean;
}

export interface Job {
  id: number;
  text: string;
  settings: Settings;
  apiKey: string;
  paused?: boolean;
  /** Shown while speaking, e.g. why there's no highlighting. */
  note?: string;
  needsAccess?: string;
}

export type ToBackground = { target: "background" } & (
  | { type: "speak-selection" | "read-page"; tabId: number }
  | { type: "pause-toggle" | "stop" }
  | { type: "get-state" }
  | { type: "page-hidden" }
  | { type: "offscreen-ready" }
  | { type: "state"; state: PlayState }
  | { type: "progress"; jobId: number; index: number; total: number; start: number; end: number }
  | { type: "done"; jobId: number }
  | { type: "idle-timeout"; jobId?: number }
);

export type ToOffscreen = { target: "offscreen" } & (
  | { type: "speak"; job: Job }
  | { type: "pause" | "resume" | "stop" }
  | { type: "get-state" }
  | { type: "settings"; settings: Settings; apiKey: string }
);

export type ToContent =
  | { type: "kokoro:highlight"; jobId: number; start: number; end: number; autoScroll: boolean }
  | { type: "kokoro:clear"; jobId: number; release?: boolean };

/** What the content script found to read. */
export interface Extracted {
  text: string;
  mapped: boolean;
  /** No selection here, but the focus is in an embedded frame from this
   *  origin (where the selection probably is). */
  frame?: string;
}
