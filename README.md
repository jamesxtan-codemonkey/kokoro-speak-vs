# Kokoro Speak (VS Code)

Read text aloud in any editor using the open-weight
[Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS model. A planned
LLM-driven step rewrites text into a speech-friendly form first.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full design.

## How it works

- **Synthesis runs in the extension host** via `onnxruntime-node` (`device: "cpu"`),
  ~3x realtime. No webview, no CSP, no browser autoplay restrictions.
- Text is split into sentences (`tts.stream()` + an explicit `TextSplitterStream`
  we `close()`), then the sentences' audio is **concatenated into one gapless WAV**
  and played through the OS audio player (`src/player.ts`: afplay /
  paplay·aplay·ffplay / PowerShell).
- `kokoroSpeak.bufferSeconds` trades smoothness vs. latency: `0` (default) buffers
  the whole selection (gapless); a positive value starts sooner with a brief gap
  at each segment boundary.

> kokoro-js is ESM-only and the host bundle is CommonJS, so it's loaded with a
> real dynamic `import()` (hidden from esbuild) to avoid `ERR_REQUIRE_ESM` on the
> Node that ships in VS Code.

## Features

- **Speak Selection** (`Cmd/Ctrl+Alt+S`; empty selection → whole document),
  **Speak Document**, **Pause/Resume** (`Cmd/Ctrl+Alt+P`), **Stop**
  (`Cmd/Ctrl+Alt+X`), right-click **Speak Selection**, and a status-bar item that
  shows state (Loading / Synthesizing selection… / Speaking / Paused) and stops
  on click.
- Markdown preview is handled: the keybinding works there and the underlying
  document is spoken with Markdown syntax stripped (`src/textprep.ts`).
- Settings: `kokoroSpeak.voice` (28 voices), `kokoroSpeak.speed` (0.5–2.0),
  `kokoroSpeak.bufferSeconds`, plus a **Select Voice** quick-pick.

## Verification

`npm test` runs a partial end-to-end round-trip: **text → Kokoro TTS → audio →
local Whisper (whisper-base.en) → text**, asserting word-level match — proof the
speech is intelligible, not just non-empty. All local, no API key.

> Finding captured as a test: both whisper base.en and small.en mishear the brand
> name "Kokoro" (out-of-vocab proper noun) — a verifier limit, not a synthesis
> defect — so ordinary words are asserted to survive while the brand name may not.

Host synthesis is verified in Node (`src/synth.ts`): real Kokoro stream
concatenates sentences into one gapless WAV at ~2.5–3x realtime; the OS player
(`src/player.ts`) is verified for finish/pause/stop and fallback.

## Layout

| Path                   | What                                                         |
|------------------------|-------------------------------------------------------------|
| `src/extension.ts`     | Host: commands, status bar, streaming play queue.            |
| `src/synth.ts`         | Host Kokoro synthesis → concatenated WAV segments.           |
| `src/player.ts`        | OS audio player wrapper (play/pause/stop, fallback chain).    |
| `src/textprep.ts`      | Markdown stripping (and future text normalization).          |
| `scripts/spike.mjs`    | Standalone Node synthesis spike → `out/spike.wav`.           |
| `test/roundtrip.test.mjs` + `test/lib/` | Round-trip TTS↔ASR verification (`npm test`). |

## Run it (F5)

```bash
npm install     # approve native postinstalls (onnxruntime-node, esbuild)
npm run build   # bundle the extension host (dist/extension.js)
# press F5 → "Run Kokoro Speak (Extension)", then select text → Cmd/Ctrl+Alt+S
```

> First Speak downloads ~80–90MB (q8 ONNX Kokoro weights) from HuggingFace and
> caches them; subsequent runs are offline.

## Packaging note

`npm run package` builds a VSIX, but because it bundles the native ML runtime
(`onnxruntime-node` + `@huggingface/transformers`) the result is **large
(~300MB) and platform-specific**. That's the trade for host-side synthesis
(fast, gapless, no webview). For real distribution this needs per-platform
targets and aggressive trimming; for local use, F5 is the intended path.
