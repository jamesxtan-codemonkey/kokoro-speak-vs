# Kokoro Speak — developer guide

How the extension works, how to build and package it, and how the voice model
is produced. The user-facing overview is the [README](../README.md); the full
original design is in [REQUIREMENTS.md](../REQUIREMENTS.md).

## Run it (F5)

```bash
npm install            # approve native postinstalls (onnxruntime-node, audify, esbuild)
npm run prepare-model  # official weights → models/kokoro-speak (Python 3.11–3.12, once)
npm run build          # bundle the extension host (dist/extension.js)
# press F5 → "Run Kokoro Speak (Extension)", then select text → Cmd/Ctrl+Alt+S
```

`prepare-model` keeps its own virtualenv in `.venv-convert` (CPU-only torch,
~1 GB). The first run converts the model in a few minutes; after that it only
verifies `models/kokoro-speak` against its manifest. Nothing is downloaded at
runtime.

## How it works

- **Synthesis runs in the extension host** via `onnxruntime-node`: no webview,
  no CSP, no browser autoplay restrictions. The model is split in two (see
  [The model](#the-model)): the text front end always runs on the CPU, and the
  vocoder runs where `kokoroSpeak.device` says, the GPU via DirectML on Windows
  (~17x realtime) or the CPU (~4x).
- **Text is chunked by us** (`chunkText` in `src/synth.ts`): sentence
  boundaries, then word-packing so no chunk exceeds 250 characters. Kokoro
  silently truncates any generation past its ~512-token context, and its own
  splitter can produce over-long chunks. Each chunk is synthesized and played
  as soon as it's ready; synthesis outruns playback, so the rest are always
  ready in time.
- **Playback — native PCM streaming** (`src/pcmplayer.ts`): where the native
  `audify` addon loads (N-API → RtAudio → CoreAudio on macOS, WASAPI on
  Windows), audio is streamed as 16-bit PCM into one persistent output stream,
  resampled from Kokoro's 24 kHz to the device rate. It's natively gapless and
  gives **exact, instant pause/resume** and **instant stop**, with no temp
  files. On Windows, WASAPI (the shared system mixer) is pinned explicitly so
  ASIO drivers aren't grabbed.
- **Fallback — file players** (`src/player.ts`): if `audify` can't load, each
  chunk is written to a temp WAV and played with the OS player (`afplay`,
  `paplay`/`aplay`/`ffplay`, or PowerShell's `SoundPlayer` on Windows). Those
  have a fixed ~0.85 s startup, so the `StreamPlayer` spawns segment N+1
  exactly `duration(N)` after segment N: the startup overlaps the previous tail
  and the seams line up. Pause kills the player (instant); resume replays the
  current sentence.
- `kokoroSpeak.bufferSeconds`: `0` (default) streams per chunk for the lowest
  latency; a larger value groups more audio per segment. Playback is gapless
  either way.

> kokoro-js is ESM-only and the host bundle is CommonJS, so it's loaded with a
> real dynamic `import()` (hidden from esbuild) to avoid `ERR_REQUIRE_ESM` on
> the Node that ships in VS Code.

## The model

Kokoro Speak runs the **official Kokoro-82M v1.0 weights**
([hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), Apache-2.0,
pinned revision, SHA-256 verified), converted to ONNX by
[tools/convert/convert.py](../tools/convert/convert.py) and **validated against
the official PyTorch model**. It ships in the VSIX as two files in
`models/kokoro-speak/`, with a `manifest.json` of provenance, hashes and
validation results:

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
| **This conversion** (GPU / CPU) | **~1.7 / ~1.2** | 1.00× |
| onnx-community fp32 | 3.8 | 1.44× |
| onnx-community q8 (what kokoro-js users usually run) | 10.3, and timing shifts | 1.41× |

The gaps come from the export, not the weights: kokoro's ONNX-friendly STFT is
an approximation (replicate padding, no window normalisation — hence +44%
loudness), and int8 quantisation shifts the duration predictor. The conversion
uses an exact convolutional STFT, keeps the model unquantised, keeps the
official vocoder noise, and picks the voice-style row the way the official
pipeline does (kokoro-js is one row off). kokoro-js is still used for its
phonemizer (espeak-ng; the official pipeline uses `misaki`, so a few words can
be phonemized differently) and its voice files (bit-identical to the official
ones).

The conversion refuses to write files unless the ONNX output matches the
official PyTorch model: same durations, loudness within 6%, spectral distance
within bounds. Its four graph exports run as parallel processes (`--jobs`).

## GPU acceleration (Windows)

On Windows the vocoder runs on the GPU through **DirectML**, which works with
any DirectX 12 GPU. `DirectML.dll` ships inside `onnxruntime-node`.

**Why the model is split:** DirectML's LSTM kernel re-plans for every new
sequence length (~1.8 s per sentence, and every sentence is a new length),
while the vocoder's convolutions are fast on the GPU. So the front end (~0.1 s
on the CPU) stays on the CPU and only the vocoder goes to the GPU. Measured on
an RTX 4090 / i7-10700, `onnxruntime-node` 1.30:

| Vocoder on | Speed |
|---|---|
| DirectML (GPU) | **~17x realtime** (first audio ~0.4 s) |
| CPU (x64) | ~4x realtime (first audio ~1.5 s) |

The GPU is checked with a short warm-up line when the model loads. If it fails
(no DirectX 12 device, a remote session without a GPU, a driver error), or
fails mid-run (e.g. device lost after sleep), the vocoder switches to the CPU,
warns once, and keeps playing.

> DirectML needs `onnxruntime-node` ≥ 1.22. 1.21 (the version
> `@huggingface/transformers` 3.8 pins) fails on Kokoro's `ConvTranspose`.
> `package.json` depends on (and `overrides` transformers to) 1.30.0.

## Normalization

Before synthesis, text is rewritten into a speech-friendly form
(`src/normalize.ts`). `deterministic` mode (the default) uses built-in local
rules plus the user's `replacements` and `spellOut`; `ai` mode has an LLM apply
the natural-language `kokoroSpeak.normalization.rules`, through a local
`claude`/`codex` CLI or the Claude API, falling back to the deterministic rules
on any failure. A local gate skips the model when there's nothing to
normalize, and results are cached. Design notes:
[normalization-design.md](normalization-design.md).

**Configure (AI)** reads [skills/normalization-config.md](../skills/normalization-config.md),
an editable instruction file, and runs the same LLM backend. Each turn the AI
returns a control to render (quick-pick, multi-select, or input box), then
proposes settings the user confirms before they're applied. Edit the `.md` to
change the menu, the questions, or how requests map to settings; no code change
needed.

## Verification

`npm test` runs the unit tests plus a partial end-to-end round-trip through the
shipped model: **text → Kokoro (`models/kokoro-speak` via `src/synth.ts`) →
audio → local Whisper (whisper-base.en) → text**, asserting word-level match.
That proves the speech is intelligible, not just non-empty. All local, no API
key; it needs the converted model (`npm run prepare-model`).

The round-trip runs the vocoder on the CPU by default; `KOKORO_DEVICE=gpu`
checks the Windows GPU path:

```powershell
$env:KOKORO_DEVICE="gpu"; node --test test/roundtrip.test.mjs
```

## Packaging (self-contained VSIX)

Each VSIX is **self-contained**: it installs and speaks **offline**, with the
extension, the native runtime and the Kokoro model inside.

```bash
npm run package:win   # → kokoro-speak-vs-win32-x64-<version>.vsix     (~250 MB)
npm run package:mac   # → kokoro-speak-vs-darwin-arm64-<version>.vsix  (~250 MB)
npm run package       # this machine's platform
npm run verify-vsix -- kokoro-speak-vs-win32-x64-<version>.vsix --install
```

Both targets can be built **from either OS**: [scripts/package.mjs](../scripts/package.mjs)
stages the target's own native binaries rather than whatever npm installed on
the host.

| Part | How it gets in the VSIX |
|---|---|
| Kokoro model (219 MB) | [scripts/prepare-model.mjs](../scripts/prepare-model.mjs) → `models/kokoro-speak`: official weights at a pinned revision, converted and validated by [tools/convert](../tools/convert/convert.py); file hashes in its `manifest.json` |
| Voices (28) | ship inside `kokoro-js` (identical to the official voice tensors) |
| `onnxruntime-node` | ships every platform; all but the target's are dropped (Windows keeps `DirectML.dll`) |
| `audify` (audio out) | the target's N-API 8 prebuilt from audify's GitHub release |
| `sharp` | replaced by a stub: transformers.js (imported by kokoro-js) loads it but only uses it for images |

[scripts/verify-vsix.mjs](../scripts/verify-vsix.mjs) checks any VSIX's
structure (model files match the bundled manifest; every native binary is the
target's OS/CPU, read from its headers). For the host's own target it also
extracts the VSIX and synthesizes speech from it **with networking disabled
in-process**, under Node and under VS Code's Electron runtime; `--install`
additionally installs it into a throwaway VS Code profile.

Targets: `win32-x64` and `darwin-arm64` (Apple silicon); `linux-x64` and
`linux-arm64` also package but are untested. **Intel Macs aren't supported**:
`onnxruntime-node` 1.30 (needed for DirectML) no longer ships `darwin-x64`
binaries.

All npm scripts run under both cmd.exe (Windows) and sh (macOS/Linux).

## Layout

| Path | What |
|---|---|
| `src/extension.ts` | Host: commands, status bar, streaming play queue. |
| `src/synth.ts` | Kokoro synthesis (front end on CPU + vocoder on GPU/CPU) → WAV segments. |
| `src/pcmplayer.ts` | Native PCM streaming (audify) and the file-player fallback adapter. |
| `src/player.ts` | OS audio player wrapper (play/pause/stop, fallback chain). |
| `src/textprep.ts` | Markdown stripping. |
| `src/normalize.ts` | Speech normalization for VS Code: the CLI backends and a cache, on top of `src/core`. |
| `src/core/` | Shared with the Chrome extension: chunking, model inputs, voices, the normalization rules and the Anthropic API call. Pure TypeScript, no Node or DOM APIs. |
| `chrome/` | The Chrome extension (WebGPU/WASM in an offscreen document, page highlighting). See [chrome/README.md](../chrome/README.md). |
| `src/speaker.ts`, `src/mcp.ts` | The vscode-free speaker and the MCP server built on it. |
| `tools/convert/` | Official weights → validated ONNX (Python; run by `npm run prepare-model`), and the fp32-compute decoder for WebGPU (`upcast_decoder.py`, run by the Chrome build). |
| `scripts/` | Model preparation, packaging and VSIX verification. |
| `skills/normalization-config.md` | Editable instructions the **Configure (AI)** flow follows. |
| `test/` | Unit tests and the TTS ↔ ASR round-trip (`npm test`). |
