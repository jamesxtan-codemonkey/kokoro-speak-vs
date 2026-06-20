// Kokoro v1.0 voice catalog, shared by the extension and the MCP server.
// Naming: <accent><gender>_<name> — a=American, b=British; f=female, m=male.

export const VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
  "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
  "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
] as const;

export type Voice = (typeof VOICES)[number];

export const DEFAULT_VOICE: Voice = "af_heart";

export function isVoice(v: string): v is Voice {
  return (VOICES as readonly string[]).includes(v);
}

/** Human-readable group for a voice id (for list_voices / pickers). */
export function describeVoice(v: string): string {
  const accent = v[0] === "b" ? "British" : "American";
  const gender = v[1] === "m" ? "male" : "female";
  return `${accent} ${gender}`;
}
