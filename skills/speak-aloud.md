---
name: speak-aloud
description: Speak your replies out loud (and chime into spoken discussions) using the Kokoro Speak MCP server's voice tools.
---

# Speak aloud

You have a `kokoro-speak` MCP server connected. It plays text on the user's
speakers with a local neural voice. Use it to **vocalize your responses** or to
**join a spoken discussion**, not just print them.

## Tools

- `speak({ text, voice?, speed? })` — say `text` aloud. Returns once the audio
  finishes. Calling it again interrupts whatever is still playing.
- `stop()` — stop talking immediately.
- `list_voices()` — list the available voice ids.

## How to use it

- When the user is in a **voice / discussion** context (they asked you to talk,
  read aloud, or join a conversation), after you write a reply, also call
  `speak` with a concise spoken version of it.
- Keep spoken text **short and conversational** — speak the gist, not long code
  blocks, tables, or file paths. Markdown is stripped automatically.
- Speak **one turn at a time**; `speak` blocks until it finishes, so don't queue
  many long calls.
- To barge in / change your mind, just call `speak` again (it interrupts) or
  `stop`.
- Pick a `voice` only if the user expresses a preference (e.g. "use a British
  male voice" → a `bm_*` id from `list_voices`); otherwise use the default.

## When NOT to speak

- The user is clearly working in text only (no indication they want audio).
- The content is long/structured (code, logs) — summarize in a sentence and
  speak that instead, or don't speak it.
