# Kokoro Speak (VS Code)

Read text aloud in any editor using the open-weight
[Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS model. A planned
LLM-driven step rewrites text into a speech-friendly form first.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full design.

## How it works

- **Synthesis runs in the extension host** via `onnxruntime-node`. No webview, no
  CSP, no browser autoplay restrictions. Where it runs is set by
  `kokoroSpeak.device` (see [GPU acceleration](#gpu-acceleration-windows)): the
  vocoder on the GPU via DirectML on Windows (~17x realtime), otherwise the CPU
  (~4x). The model is the official one, converted and validated — see
  [The model](#the-model).
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

## The model

Kokoro Speak runs the **official Kokoro-82M v1.0 weights**
([hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), Apache-2.0,
pinned revision, SHA-256 verified), converted to ONNX by
[tools/convert/convert.py](tools/convert/convert.py) and **validated against the
official PyTorch model** before it's packaged. It ships in the VSIX as two
files in `models/kokoro-speak/` (with a `manifest.json` of provenance, hashes
and validation results):

| File | Precision | What it does | Runs on |
|---|---|---|---|
| `frontend.onnx` (112 MB) | fp32 | phonemes → durations, pitch, features (all the LSTMs) | CPU |
| `decoder.onnx` (107 MB) | fp16 network, fp32 phase/STFT math | features → 24 kHz audio (the vocoder) | GPU (Windows) or CPU |

**Why not the ready-made ONNX** (`onnx-community/Kokoro-82M-v1.0-ONNX`, which
kokoro-js loads by default)? Measured against the official model (log-spectral
distance; the official model differs from *itself* by ~1.2 between runs, since
its vocoder adds random noise):

| Model | Distance from official | Loudness vs official |
|---|---|---|
| **This conversion** (GPU / CPU) | **~1.4–1.7** | 0.97–1.00× |
| onnx-community fp32 | 3.8 | 1.44× |
| onnx-community q8 (what kokoro-js users usually run) | 10.3, and timing shifts | 1.41× |

The gaps come from the export, not the weights: kokoro's ONNX-friendly STFT is
an approximation (replicate padding, no window normalisation — hence +44%
loudness), and int8 quantisation shifts the duration predictor. The conversion
uses an exact convolutional STFT, keeps the model unquantised, keeps the
official vocoder noise, and picks the voice-style row the way the official
pipeline does (kokoro-js is one row off). kokoro-js is still used for its
phonemizer (espeak-ng — the official pipeline uses `misaki`, so a few words can
be phonemized differently) and its voice files (bit-identical to the official
ones).

## GPU acceleration (Windows)

On Windows the vocoder runs on the GPU through **DirectML**, which works with
any DirectX 12 GPU (NVIDIA, AMD, Intel; integrated GPUs included). No CUDA
install is needed — `DirectML.dll` ships inside `onnxruntime-node`.

| Setting | Values |
|---|---|
| `kokoroSpeak.device` | `auto` (default: GPU if the platform has one, else CPU) · `gpu` · `cpu` |

Why the model is split: DirectML's LSTM kernel re-plans for every new sequence
length (~1.8 s per sentence — every sentence is a new length), while the
vocoder's convolutions are fast on the GPU. So the frontend (~0.1 s on the CPU)
stays on the CPU and only the vocoder goes to the GPU. Measured on an RTX 4090 /
i7-10700, `onnxruntime-node` 1.30:

| Vocoder on | Speed |
|---|---|
| DirectML (GPU) | **~17x realtime** (first audio ~0.4 s) |
| CPU (x64) | ~4x realtime (first audio ~1.5 s) |

The GPU is checked with a short warm-up line when the model loads. If it fails
(no DirectX 12 device, a remote session without a GPU, a driver error), or
fails mid-run (e.g. device lost after sleep), the vocoder switches to the CPU,
warns once, and keeps playing. The status-bar tooltip shows where it runs.
macOS and Linux run on the CPU.

> DirectML needs `onnxruntime-node` ≥ 1.22 — 1.21 (the version
> `@huggingface/transformers` 3.8 pins) fails on Kokoro's `ConvTranspose`.
> `package.json` depends on (and `overrides` transformers to) 1.30.0.

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
  `kokoroSpeak.bufferSeconds`, `kokoroSpeak.device`, plus a **Select Voice**
  quick-pick.

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

`npm test` runs a partial end-to-end round-trip through the shipped model: **text
→ Kokoro (models/kokoro-speak via `src/synth.ts`) → audio → local Whisper
(whisper-base.en) → text**, asserting word-level match — proof the speech is
intelligible, not just non-empty. All local, no API key. (Needs the converted
model: `npm run prepare-model`.)

> Finding captured as a test: both whisper base.en and small.en mishear the brand
> name "Kokoro" (out-of-vocab proper noun) — a verifier limit, not a synthesis
> defect — so ordinary words are asserted to survive while the brand name may not.

Host synthesis is verified in Node (`src/synth.ts`): real Kokoro stream
concatenates sentences into one gapless WAV at ~2.5–3x realtime; the OS player
(`src/player.ts`) is verified for finish/pause/stop and fallback.

The round-trip runs the vocoder on the CPU by default; `KOKORO_DEVICE=gpu` checks
the Windows GPU path:

```powershell
$env:KOKORO_DEVICE="gpu"; node --test test/roundtrip.test.mjs
```

The model conversion has its own gates: [tools/convert/convert.py](tools/convert/convert.py)
refuses to write files unless the ONNX output matches the official PyTorch
model (same durations, loudness within 6%, spectral distance within bounds).

## Layout

| Path                   | What                                                         |
|------------------------|-------------------------------------------------------------|
| `src/extension.ts`     | Host: commands, status bar, streaming play queue.            |
| `src/synth.ts`         | Host Kokoro synthesis (frontend CPU + vocoder GPU/CPU) → WAV segments. |
| `tools/convert/`       | Official weights → validated ONNX (Python; run by `npm run prepare-model`). |
| `src/player.ts`        | OS audio player wrapper (play/pause/stop, fallback chain).    |
| `src/textprep.ts`      | Markdown stripping.                                           |
| `src/normalize.ts`     | Speech normalization: deterministic rules + LLM (CLI/API).   |
| `skills/normalization-config.md` | Editable instructions the AI **⚙ Config** flow follows. |
| `scripts/spike.mjs`    | Standalone Node synthesis spike → `out/spike.wav`.           |
| `test/roundtrip.test.mjs` + `test/lib/` | Round-trip TTS↔ASR verification (`npm test`). |

## Run it (F5)

```bash
npm install            # approve native postinstalls (onnxruntime-node, audify, esbuild)
npm run prepare-model  # official weights → models/kokoro-speak (Python 3.10–3.12, once)
npm run build          # bundle the extension host (dist/extension.js)
# press F5 → "Run Kokoro Speak (Extension)", then select text → Cmd/Ctrl+Alt+S
```

> `prepare-model` keeps its own virtualenv in `.venv-convert` (CPU-only torch,
> ~1 GB) and takes a few minutes the first time; afterwards it just verifies
> `models/kokoro-speak` against its manifest. Nothing is downloaded at runtime.

## Packaging (self-contained VSIX)

Each VSIX is **self-contained**: it installs and speaks **offline**, with the
extension, the native runtime and the Kokoro model inside — nothing is
downloaded on first use.

```bash
npm run package:win   # → kokoro-speak-vs-win32-x64-<version>.vsix     (~250 MB)
npm run package:mac   # → kokoro-speak-vs-darwin-arm64-<version>.vsix  (~250 MB)
npm run package       # this machine's platform
npm run verify-vsix -- kokoro-speak-vs-win32-x64-<version>.vsix --install
```

Both targets can be built **from either OS** — [scripts/package.mjs](scripts/package.mjs)
stages the target's own native binaries rather than whatever npm installed on
the host:

| Part | How it gets in the VSIX |
|---|---|
| Kokoro model (219 MB) | [scripts/prepare-model.mjs](scripts/prepare-model.mjs) → `models/kokoro-speak`: official weights at a pinned revision, converted + validated by [tools/convert](tools/convert/convert.py); file hashes in its `manifest.json` |
| Voices (28) | ship inside `kokoro-js` (identical to the official voice tensors) |
| `onnxruntime-node` | ships every platform; all but the target's are dropped (Windows keeps `DirectML.dll`) |
| `audify` (audio out) | the target's N-API 8 prebuilt from audify's GitHub release |
| `sharp` | replaced by a stub — transformers.js (imported by kokoro-js) loads it but only uses it for images |

[scripts/verify-vsix.mjs](scripts/verify-vsix.mjs) checks any VSIX's structure
(model files match the bundled manifest; every native binary is the target's
OS/CPU, read from its headers). For the host's own target it also extracts the
VSIX and synthesizes speech from it **with networking disabled in-process**,
under Node and under VS Code's Electron runtime; `--install` additionally installs it
into a throwaway VS Code profile. Install a VSIX with **Extensions: Install from
VSIX…** or `code --install-extension <file>.vsix`.

Targets: `win32-x64` and `darwin-arm64` (Apple silicon); `linux-x64`/`linux-arm64`
also package. **Intel Macs aren't supported** — `onnxruntime-node` 1.30 (needed
for DirectML) no longer ships `darwin-x64` binaries.

All npm scripts run under both cmd.exe (Windows) and sh (macOS/Linux).
