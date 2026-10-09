# Kokoro Speak (VS Code)

Read text aloud in any editor using the open-weight
[Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS model. A planned
LLM-driven step rewrites text into a speech-friendly form first.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full design.

## How it works

- **Synthesis runs in the extension host** via `onnxruntime-node`. No webview, no
  CSP, no browser autoplay restrictions. Where it runs is set by
  `kokoroSpeak.device` (see [GPU acceleration](#gpu-acceleration-windows)): the
  GPU via DirectML on Windows (~25x realtime), otherwise the CPU (~3–4x).
- Text is split into sentences (`tts.stream()` + an explicit `TextSplitterStream`
  we `close()`). Each sentence is played as soon as it's synthesized — and because
  host synthesis (~3x) outruns playback, the rest are always ready in time.
- **Playback — native PCM streaming** (`src/pcmplayer.ts`): on a host where the
  native `audify` addon loads (N-API → RtAudio → CoreAudio), audio is streamed as
  16-bit PCM into one persistent output stream (Kokoro's 24 kHz resampled to the
  device rate). This is natively gapless and gives **exact, instant pause/resume**
  (`rt.stop()`/`start()` at the precise sample) and **instant stop** — no temp
  files. This is the macOS and Windows path (Windows uses WASAPI, the shared
  system mixer — pinned explicitly so ASIO drivers aren't grabbed).
- **Fallback — file players** (`src/player.ts`): if `audify` can't load (or on a
  platform without it), each sentence is written to a temp WAV and played with the
  OS CLI player (`afplay`/`paplay`/`aplay`/`ffplay`; PowerShell's `SoundPlayer`
  on Windows). Those can't be fed a stream
  and have a fixed ~0.85 s startup, so the `StreamPlayer` hides it by spawning
  segment N+1 exactly `duration(N)` after segment N — the startup overlaps the
  previous tail and seams line up. (Verified: three 1.0 s segments play in ~3.9 s,
  one startup not three.) Here pause kills the player (instant) and resume replays
  the current sentence.
- `kokoroSpeak.bufferSeconds`: `0` (default) streams per sentence for the lowest
  latency; a larger value groups more audio per segment. Playback is gapless
  either way.

> kokoro-js is ESM-only and the host bundle is CommonJS, so it's loaded with a
> real dynamic `import()` (hidden from esbuild) to avoid `ERR_REQUIRE_ESM` on the
> Node that ships in VS Code.

## GPU acceleration (Windows)

On Windows, Kokoro runs on the GPU through **DirectML**, which works with any
DirectX 12 GPU (NVIDIA, AMD, Intel; integrated GPUs included). No CUDA install is
needed — `DirectML.dll` ships inside `onnxruntime-node`.

| Setting | Values |
|---|---|
| `kokoroSpeak.device` | `auto` (default: GPU if the platform has one, else CPU) · `gpu` · `cpu` |
| `kokoroSpeak.precision` | `auto` (default) · `q8` · `fp16` · `fp32` |

The GPU is checked with a short warm-up line when the model loads. If it fails
(no DirectX 12 device, a remote session without a GPU, a driver error), or the
GPU fails mid-run (e.g. device lost after sleep), synthesis switches to the CPU,
warns once, and keeps playing. The status-bar tooltip shows the engine in use,
e.g. *GPU (DirectML), q8*. Changing either setting reloads the model on the next
Speak.

Measured on an RTX 4090 / i7-10700, `onnxruntime-node` 1.30:

| Backend | q8 | fp16 | fp32 |
|---|---|---|---|
| DirectML (GPU) | **~25–30x** | ~6x | ~6x |
| CPU (x64) | ~1.2x | ~5x | ~4x |

So `auto` precision picks **q8 on the GPU** and prefers **fp32 on a Windows x64
CPU** (q8 is barely faster than playback there, which can stutter). DirectML only
keeps its fast path for the first input shape it sees, and every sentence has a
different length; the quantized model's ops stay fast regardless, the float
models don't. macOS and Linux keep CPU + q8 as before.

Only q8 ships in the VSIX (see [Packaging](#packaging-self-contained-vsix)), so a
Windows machine that ends up on the CPU starts on the bundled q8 and offers a
one-time **Download faster CPU model (325 MB)**. It's stored in VS Code's global
storage (survives extension updates) and used automatically from then on.

> DirectML needs `onnxruntime-node` ≥ 1.22 — 1.21 (the version
> `@huggingface/transformers` 3.8 pins) fails on Kokoro's `ConvTranspose`.
> `package.json` `overrides` pins `onnxruntime-node`/`onnxruntime-common` to
> 1.30.0.

## Features

- **Speak Selection** (`Cmd/Ctrl+Alt+S`; empty selection → whole document),
  **Speak Document**, **Speak Clipboard** (`Cmd/Ctrl+Alt+V` — works from any
  webview panel such as the Claude Code panel or Markdown preview: copy, then
  press it), **Pause/Resume** (`Cmd/Ctrl+Alt+P`), **Stop**
  (`Cmd/Ctrl+Alt+X`), right-click **Speak Selection**, and a status-bar item that
  shows state (Loading / Synthesizing selection… / Speaking / Paused).
  **Clicking** the status item toggles **Pause/Resume** while playing (and speaks
  the clipboard when idle). The full controls — **Speak clipboard · Pause/Resume ·
  Stop · Config** — are command links in the item's **hover tooltip** (status
  items support only one click action and no right-click, and VS Code can't pin a
  popup open, so the tooltip is the control surface).
- Markdown preview is handled: the keybinding works there and the underlying
  document is spoken with Markdown syntax stripped (`src/textprep.ts`).
- Settings: `kokoroSpeak.voice` (28 voices), `kokoroSpeak.speed` (0.5–2.0),
  `kokoroSpeak.bufferSeconds`, `kokoroSpeak.device` / `kokoroSpeak.precision`,
  plus a **Select Voice** quick-pick.

## Normalization

Before synthesis, text is rewritten into a speech-friendly form
(`src/normalize.ts`, `$10B → 10 billion dollars`). Three modes via
`kokoroSpeak.normalization.mode`:

- `off` — none (Markdown is still stripped).
- `deterministic` (**default**) — built-in local rules + your `replacements`.
  Offline, instant, private. Expands currency/percent/versions/quarters/
  abbreviations/symbols and leaves bare digits for Kokoro to vocalize.
- `ai` — an LLM applies your natural-language `kokoroSpeak.normalization.rules`;
  falls back to the deterministic rules on any failure. Opt-in (asks once before
  first use, since it sends the spoken text to a model). Backend `auto` detects a
  local `claude`/`codex` CLI (no API key) or uses the Claude API
  (`Kokoro Speak: Set Normalization API Key`). A local gate skips the model when
  there's nothing to normalize, and results are cached.

Customize per user (User settings) or per repo (`.vscode/settings.json`):
`kokoroSpeak.normalization.rules` (natural language) and `.replacements`
(literal/regex), e.g. `{ "from": "K8s", "to": "Kubernetes" }`. Design notes:
[docs/normalization-design.md](docs/normalization-design.md).

### AI-driven config

The status-bar tooltip has a **⚙ Config** link (also `Kokoro Speak: Configure
(AI)`). It reads [skills/normalization-config.md](skills/normalization-config.md)
— an editable instruction file — and runs the same LLM backend. It configures the
**voice** and **speed** as well as normalization, so plain-language requests like
*"use a British male voice"* or *"talk a bit slower"* set `kokoroSpeak.voice` /
`kokoroSpeak.speed` for you (the model is given the catalog of valid voice ids).

The **AI chooses the UI on the fly**: each turn it returns a control to render,
and the extension shows it natively — a quick-pick (choose one), a multi-select
quick-pick (choose several), or an input box (free text). It opens with a pick
menu of common actions, asks follow-ups as needed, then proposes settings you
confirm before they're applied (to workspace settings if a folder is open, else
user settings). Update the `.md` to change the menu, the questions, or how
requests map to settings — no code change. Falls back to the Settings UI if no
backend is available.

## Voice for AI agents (MCP)

A standalone MCP server (`kokoro-speak-mcp`) lets an MCP-capable agent — Claude
Code, the Codex VS Code extension, Claude Desktop — **speak its replies aloud or
join a spoken discussion** by calling a `speak` tool. It reuses the same
vscode-free core (`src/speaker.ts`) and keeps the model warm. Build with
`npm run build:mcp` (→ `dist/mcp.js`), register it with your agent, and
optionally add the [speak-aloud skill](skills/speak-aloud.md) so it speaks
proactively. Full setup: [docs/mcp-voice.md](docs/mcp-voice.md).

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

The round-trip runs on CPU by default. To verify another backend, set
`KOKORO_DEVICE` / `KOKORO_DTYPE`, e.g. the Windows GPU path:

```powershell
$env:KOKORO_DEVICE="dml"; node --test test/roundtrip.test.mjs
```

## Layout

| Path                   | What                                                         |
|------------------------|-------------------------------------------------------------|
| `src/extension.ts`     | Host: commands, status bar, streaming play queue.            |
| `src/synth.ts`         | Host Kokoro synthesis → concatenated WAV segments.           |
| `src/player.ts`        | OS audio player wrapper (play/pause/stop, fallback chain).    |
| `src/textprep.ts`      | Markdown stripping.                                           |
| `src/normalize.ts`     | Speech normalization: deterministic rules + LLM (CLI/API).   |
| `skills/normalization-config.md` | Editable instructions the AI **⚙ Config** flow follows. |
| `scripts/spike.mjs`    | Standalone Node synthesis spike → `out/spike.wav`.           |
| `test/roundtrip.test.mjs` + `test/lib/` | Round-trip TTS↔ASR verification (`npm test`). |

## Run it (F5)

```bash
npm install     # approve native postinstalls (onnxruntime-node, audify, esbuild)
npm run build   # bundle the extension host (dist/extension.js)
# press F5 → "Run Kokoro Speak (Extension)", then select text → Cmd/Ctrl+Alt+S
```

> F5 uses the model in `models/` if you've run `npm run fetch-model` (packaging
> does it for you); otherwise the first Speak downloads the q8 weights (~90 MB)
> from Hugging Face and caches them.

## Packaging (self-contained VSIX)

Each VSIX is **self-contained**: it installs and speaks **offline**, with the
extension, the native runtime and the Kokoro model inside — nothing is
downloaded on first use.

```bash
npm run package:win   # → kokoro-speak-vs-win32-x64-<version>.vsix     (~117 MB)
npm run package:mac   # → kokoro-speak-vs-darwin-arm64-<version>.vsix  (~115 MB)
npm run package       # this machine's platform
npm run verify-vsix -- kokoro-speak-vs-win32-x64-<version>.vsix --install
```

Both targets can be built **from either OS** — [scripts/package.mjs](scripts/package.mjs)
stages the target's own native binaries rather than whatever npm installed on
the host:

| Part | How it gets in the VSIX |
|---|---|
| Kokoro model (q8, 92 MB) | [scripts/fetch-model.mjs](scripts/fetch-model.mjs) → `models/`, pinned HF revision + SHA-256 |
| Voices (28) | ship inside `kokoro-js` |
| `onnxruntime-node` | ships every platform; all but the target's are dropped (Windows keeps `DirectML.dll`) |
| `audify` (audio out) | the target's N-API 8 prebuilt from audify's GitHub release |
| `sharp` | replaced by a stub — transformers.js imports it but only uses it for images |

[scripts/verify-vsix.mjs](scripts/verify-vsix.mjs) checks any VSIX's structure
(model hashes; every native binary is the target's OS/CPU, read from its
headers). For the host's own target it also extracts the VSIX and synthesizes
speech from it **with downloads disabled** (`KOKORO_SPEAK_OFFLINE=1`), under
Node and under VS Code's Electron runtime; `--install` additionally installs it
into a throwaway VS Code profile. Install a VSIX with **Extensions: Install from
VSIX…** or `code --install-extension <file>.vsix`.

Targets: `win32-x64` and `darwin-arm64` (Apple silicon); `linux-x64`/`linux-arm64`
also package. **Intel Macs aren't supported** — `onnxruntime-node` 1.30 (needed
for DirectML) no longer ships `darwin-x64` binaries.

All npm scripts run under both cmd.exe (Windows) and sh (macOS/Linux).
