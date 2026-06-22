# Kokoro Speak (VS Code)

Read text aloud in any editor using the open-weight
[Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS model. A planned
LLM-driven step rewrites text into a speech-friendly form first.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full design.

## How it works

- **Synthesis runs in the extension host** via `onnxruntime-node` (`device: "cpu"`),
  ~3x realtime. No webview, no CSP, no browser autoplay restrictions.
- Text is split into sentences (`tts.stream()` + an explicit `TextSplitterStream`
  we `close()`). Each sentence is played as soon as it's synthesized — and because
  host synthesis (~3x) outruns playback, the rest are always ready in time.
- **Playback — native PCM streaming** (`src/pcmplayer.ts`): on a host where the
  native `audify` addon loads (N-API → RtAudio → CoreAudio), audio is streamed as
  16-bit PCM into one persistent output stream (Kokoro's 24 kHz resampled to the
  device rate). This is natively gapless and gives **exact, instant pause/resume**
  (`rt.stop()`/`start()` at the precise sample) and **instant stop** — no temp
  files. This is the macOS path.
- **Fallback — file players** (`src/player.ts`): if `audify` can't load (or on a
  platform without it), each sentence is written to a temp WAV and played with the
  OS CLI player (`afplay`/`paplay`/`aplay`/`ffplay`). Those can't be fed a stream
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
  `kokoroSpeak.bufferSeconds`, plus a **Select Voice** quick-pick.

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

### Per-file-type (code vs prose)

Normalization adapts to the **file type** of a selection/document (via its
`languageId`). Markdown is de-marked-down; **source files use a code profile**;
everything else is prose. (Clipboard text has no known origin type, so it's
normalized as prose.)

- **Identifiers** are split into words in every mode —
  `getUserName → "get User Name"`, `MAX_BUFFER → "MAX BUFFER"` — with common
  brand names (`JavaScript`, `GitHub`…) kept whole.
- **Code profile** additionally expands operators (`==` → "equals", `&&` →
  "and", `>=` → "greater than or equal", …) and **skips** prose-only rules that
  misfire on code (`$` variables, `%` modulo).
- **Comment-aware:** comment markers (`//`, `#`, `/* */`, `<!-- -->`, …) are
  removed so they aren't spoken. `kokoroSpeak.normalization.codeReading` chooses
  `all` (read everything) or `comments` (read only comments + docstrings).
- **Per-language overrides:** `kokoroSpeak.normalization.byLanguage` keys extra
  `replacements`/`spellOut` (and an optional `profile`/`rules`) by language id,
  e.g. `{ "c": { "spellOut": ["GPIO", "UART"] } }`.
- In `ai` mode, the file type is passed to the model as context.

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
join a spoken discussion** by calling a `speak` tool. It's bundled in the
installed extension (`dist/mcp.js`), runs offline (bundled model), and reuses the
same vscode-free core (`src/speaker.ts`).

**Just tell your AI agent: _"install the Kokoro Speak MCP server."_** It has
step-by-step instructions to follow in **[MCP-FOR-AGENTS.md](MCP-FOR-AGENTS.md)**
(also shipped inside the extension). The gist — find the bundled server and
register it:

```bash
# 1. locate it (newest installed copy across VS Code / Cursor / Windsurf / Remote)
find ~/.vscode/extensions ~/.cursor/extensions ~/.windsurf/extensions \
  -maxdepth 3 -path '*/jamestan.kokoro-speak-vs-*/dist/mcp.js' 2>/dev/null | sort -V | tail -1
# 2. register with Claude Code (use the path from step 1)
claude mcp add kokoro-speak -- node "<PATH>"
```

Optionally add the [speak-aloud skill](skills/speak-aloud.md) so it speaks
proactively. Full reference: [docs/mcp-voice.md](docs/mcp-voice.md).

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
| `src/textprep.ts`      | Structural cleanup by file type (Markdown strip / code prep). |
| `src/codeprep.ts`      | Per-file-type profile + comment-aware code reading.          |
| `src/normalize.ts`     | Speech normalization: deterministic rules + LLM (CLI/API).   |
| `skills/normalization-config.md` | Editable instructions the AI **⚙ Config** flow follows. |
| `scripts/spike.mjs`    | Standalone Node synthesis spike → `out/spike.wav`.           |
| `test/roundtrip.test.mjs` + `test/lib/` | Round-trip TTS↔ASR verification (`npm test`). |

## Run it (F5)

```bash
npm install     # approve native postinstalls (onnxruntime-node, esbuild)
npm run build   # bundle the extension host (dist/extension.js)
# press F5 → "Run Kokoro Speak (Extension)", then select text → Cmd/Ctrl+Alt+S
```

> For development (F5 from source), run `npm run fetch-model` once to download
> the q8 ONNX Kokoro weights (~88MB) into `model/`. The packaged VSIX bundles
> them, so installed users need no download.

## Offline / air-gapped use

**The model is bundled in the extension** (the `model/` folder, fetched at
package time and shipped in the VSIX). Installed copies work fully offline with
zero configuration — nothing is downloaded at runtime, and the voices already
ship inside the `kokoro-js` package.

If you need to point at a different copy of the model — or the bundle is somehow
missing — use a manual folder:

1. On a machine with internet, open
   [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
   and download these files, keeping the `onnx/` subfolder layout:
   - `config.json`
   - `tokenizer.json`
   - `tokenizer_config.json`
   - `onnx/model_quantized.onnx` (the q8 weights, ~88MB)
2. Put them in one folder (any name), e.g.

   ```
   kokoro-model/
   ├── config.json
   ├── tokenizer.json
   ├── tokenizer_config.json
   └── onnx/
       └── model_quantized.onnx
   ```
3. Copy that folder to the target machine.
4. Run **Kokoro Speak: Set Model Path** (or set `kokoroSpeak.modelPath` in
   Settings) and select the folder. The extension verifies the files are present
   before saving, then loads entirely from disk.

The load order is: `kokoroSpeak.modelPath` (if set) → bundled model → download
from HuggingFace (only if no bundle is present). If a load ever fails, the status
bar shows an error and offers **Set model path** to walk you through the manual
steps and continue once a valid folder is selected.

## Packaging note

`npm run package` builds a VSIX, but because it bundles the native ML runtime
(`onnxruntime-node` + `@huggingface/transformers`) the result is **large
(~300MB) and platform-specific**. That's the trade for host-side synthesis
(fast, gapless, no webview). For real distribution this needs per-platform
targets and aggressive trimming; for local use, F5 is the intended path.
