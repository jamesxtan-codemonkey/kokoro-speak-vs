# Kokoro Speak — VS Code Extension Requirements

> Status: Draft v0.1 · Date: 2026-06-18 · Owner: jamesxtan@gmail.com

## 1. Summary

**Kokoro Speak** is a VS Code extension that reads text aloud from any text
editor using the open-weight [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M)
text-to-speech model. Before synthesis, text passes through an **LLM-driven
normalization agent** that rewrites it into a speech-friendly form (e.g.
`$10B` → `ten billion dollars`, `v1.2.3` → `version one point two point three`).

Design pillars:

- **Local-first audio.** Synthesis runs on-device; no audio leaves the machine.
- **Smart normalization.** Rules are authored in natural language and applied at
  runtime by an LLM agent, so they're easy to extend without code changes.
- **Zero-friction install.** Default runtime requires no Python and no external
  server — just install the extension.

## 2. Goals

- Speak the current selection, or the whole document if nothing is selected.
- Convert text to a TTS-friendly form via configurable, natural-language rules.
- Provide playback controls (play / pause / stop) and highlight the sentence
  currently being spoken.
- Let users choose among Kokoro's voices and adjust speaking speed.
- Work offline for synthesis once the model is cached.

## 3. Non-goals (v1)

- Speech-to-text / dictation.
- Reading non-text editors (e.g. notebooks output, terminal) — text editors only.
- Multi-language UI localization (English-first; Kokoro multilingual voices are
  a stretch goal — see §9).
- Cloud-hosted synthesis or a shared server backend.

## 4. Architecture

### 4.1 Runtime — kokoro-js in the host (onnxruntime-node)

**Decision (current):** Run [`kokoro-js`](https://www.npmjs.com/package/kokoro-js)
in the **extension host** via `onnxruntime-node` (`device: "cpu"`), ~3x realtime.

We first ran it in a **webview** (ONNX-Runtime-Web, WASM) to keep the VSIX small
and avoid native binaries. That worked but had two compounding problems: WASM was
single-threaded (~0.7x realtime), and webview audio hit Chromium's autoplay rule.
Moving inference to the host fixed both — synthesis is ~4x faster (so buffering
the whole selection for gapless playback is quick), and there's no webview, CSP,
or autoplay gesture.

Trade-off: the host path bundles native binaries (`onnxruntime-node`), so the
VSIX is large (~300 MB) and platform-specific (see §11). Local/F5 use is
unaffected; model weights (≈ 80–90 MB at `q8`) still download once and cache.

ESM note: kokoro-js is ESM-only and the host bundle is CommonJS, so it's loaded
with a real dynamic `import()` (hidden from esbuild) to dodge `ERR_REQUIRE_ESM`
on the Node inside VS Code.

### 4.2 Process / component layout

```
┌─────────────────────────────────────────────────────────────┐
│ VS Code Editor                                               │
│   selection / document  ──┐                                  │
└───────────────────────────┼──────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Extension Host (Node.js) — everything runs here              │
│  1. Capture text (selection / document; de-markdown)         │
│  2. [planned] Normalization agent → speech-friendly text     │
│  3. kokoro-js synth (onnxruntime-node): stream sentences,    │
│     concatenate into gapless WAV segment(s)                  │
│  4. Play segments in order via the OS audio player           │
│     (afplay / paplay·aplay·ffplay / PowerShell);             │
│     pause = SIGSTOP/SIGCONT, stop = kill                     │
└─────────────────────────────────────────────────────────────┘
```

Notes:

- **No webview.** Synthesis and playback both run in the host.
- Text is split into sentences (Kokoro's ~510-token limit would otherwise
  truncate), then **concatenated into one gapless WAV** so there's a single
  OS-player launch (each launch costs ~0.85 s — the source of per-sentence gaps).
  `bufferSeconds` tunes how much to buffer before playback (§7).
- Synthesis at ~3x realtime keeps the time-to-first-audio low even though we
  buffer for gaplessness (e.g. a 40 s clip ≈ 13 s synth, then gapless).

### 4.3 Optional performance mode — Python sidecar (future)

Spawn a local Python process running the official Kokoro pipeline (PyTorch/ONNX),
communicate over stdio/JSON. Gated behind a setting and a detected Python env.
Out of scope for v1; documented so the architecture leaves room for it.

## 5. Functional requirements

### 5.1 Commands

| Command ID                       | Title                          | Default keybinding |
|----------------------------------|--------------------------------|--------------------|
| `kokoroSpeak.speakSelection`     | Speak Selection                | `Ctrl/Cmd+Alt+S`   |
| `kokoroSpeak.speakDocument`      | Speak Document                 | —                  |
| `kokoroSpeak.pause`              | Pause / Resume                 | `Ctrl/Cmd+Alt+P`   |
| `kokoroSpeak.stop`               | Stop                           | `Ctrl/Cmd+Alt+X`   |
| `kokoroSpeak.selectVoice`        | Select Voice                   | —                  |

- `speakSelection` with an empty selection falls back to the whole document.
- A **right-click context menu** entry — “Speak with Kokoro” — appears in the
  editor when there is a selection.

### 5.2 Playback controls

- **Status bar item** showing state: idle / normalizing / speaking / paused, with
  inline play-pause-stop affordances.
- **Sentence highlighting:** the sentence currently being spoken is highlighted
  in the editor (decoration), advancing as playback progresses.
- Play / pause / resume / stop. Stop clears highlighting and resets position.

### 5.3 Voice & speed settings

- Pick among Kokoro voices (see §9). Quick-pick UI via `selectVoice`.
- Speaking speed multiplier (e.g. `0.5×`–`2.0×`).
- All settings live under the `kokoroSpeak.*` namespace (§7).

## 6. Normalization agent (LLM)

### 6.1 Behavior

Before synthesis, text is rewritten into a speech-friendly form by an LLM agent.
Rules are authored in **natural language** and supplied to the model at runtime,
so users/maintainers can extend them without code changes. The agent is reached
through a **pluggable backend** (§6.6) — by default a local CLI agent the
developer already has installed, so there is no API key to configure.

Example transformations (seed rule set):

| Input            | Spoken form                          |
|------------------|--------------------------------------|
| `$10B`           | `ten billion dollars`                |
| `$3.5M`          | `three point five million dollars`   |
| `v1.2.3`         | `version one point two point three`  |
| `~50%`           | `about fifty percent`                |
| `Q4 2025`        | `fourth quarter twenty twenty-five`  |
| `e.g.` / `i.e.`  | `for example` / `that is`            |
| `GET /api/users` | `GET slash A P I slash users`        |
| code identifiers | read sensibly (camelCase → words)    |

### 6.2 Contract

- **Input:** raw text span + the active rule set (natural-language rules).
- **Output:** normalized plain text only — **no commentary, no markdown**.
- **Invariant:** the model must not add, remove, or reorder semantic content
  beyond what the rules specify; it only rewrites surface forms for speech.
- Operates per **sentence/segment** to bound latency and enable streaming.

### 6.3 Latency, cost, and caching

Routing the hot path through an LLM adds latency — and for the CLI backend, a
**process cold start** (1–3 s) that dwarfs the actual inference. Mitigations:

- **Warm process:** for the CLI backend, keep **one long-lived agent process**
  alive and feed it spans over stdin, rather than spawning per sentence (§6.6).
- **Cache** normalized output keyed by `(text, ruleSetHash, backendId)` —
  repeated or unchanged spans skip the agent entirely.
- **Gate:** a cheap local pre-check skips normalization for spans with no
  candidates (no digits, symbols, abbreviations, or mixed-case identifiers).
- **Batching / look-ahead:** normalize upcoming sentences ahead of playback while
  the current one is spoken, hiding latency behind audio.
- Default to a **fast, low-cost model** (e.g. Claude Haiku class) where the
  backend lets us choose.

### 6.4 Privacy

- Normalization sends text to whatever the chosen backend routes to (a cloud
  model in all current backends). This MUST be **clearly disclosed** and
  **opt-in on first use**.
- A setting disables the LLM entirely and uses only the deterministic fallback
  (fully offline). See §6.5.
- Only the **text to speak** is sent — never file paths, repo names, workspace
  contents, or other metadata. The CLI backend MUST run with **tools/file access
  disabled** so the agent cannot read the workspace (§6.6).

### 6.5 Deterministic fallback (offline / safety net)

A built-in deterministic rule engine (regex/code) handles the most common cases
(currency, percentages, common abbreviations, version strings). Used when:

- The user disables the LLM, or
- No backend is available (no CLI installed / no key / no network), or
- The backend call fails or times out.

This guarantees the extension always speaks, just less cleverly offline.

### 6.6 Normalization backends (pluggable)

Normalization is reached through a `NormalizationBackend` interface
(`normalize(text, rules) → string`). Three implementations ship; the active one
is chosen by `normalization.backend` (§7), defaulting to `cli-auto`.

**A. CLI agent (default) — `cli`/`cli-auto`.**
Drive a locally installed agent CLI that already carries the developer's auth, so
**no API key is needed**. `cli-auto` detects an available CLI in order
(`claude` → `codex` → custom); `cli` uses an explicit `normalization.command`.

- **Claude Code:** `claude -p <prompt> --output-format json` with tools disabled
  (`--allowed-tools ""`) and a single turn — a pure text transform.
- **Codex:** `codex exec <prompt>` in a read-only / no-tool sandbox.
- **Warm process:** keep one long-lived CLI process and stream spans over stdin
  (e.g. Claude `stream-json` I/O) to avoid per-request cold start. Fall back to
  one-shot spawns if streaming isn't available.
- **Hardening (required):** the agent runs with **no file/tool/network-tool
  access** and **no workspace context** — it must only see the span + rules and
  emit normalized text. This is both a privacy and a latency guarantee.
- **Cost:** consumes the user's existing CLI quota/subscription; disclosed in §6.4.

**B. Direct API — `api`.**
Call the Claude API directly with a key from VS Code SecretStorage. Lowest and
most predictable latency; requires the user to provide a key. Model configurable
via `normalization.model`.

**C. Deterministic — `none`.**
No LLM; the offline rule engine (§6.5) only. Fully private and instant.

Output hygiene: regardless of backend, responses are parsed strictly (prefer JSON
output) and stripped of any prose/markdown wrapping before synthesis.

## 7. Configuration (`kokoroSpeak.*`)

| Setting                          | Type    | Default            | Description                                        |
|----------------------------------|---------|--------------------|----------------------------------------------------|
| `voice`                          | string  | `af_heart`         | Kokoro voice id.                                   |
| `speed`                          | number  | `1.0`              | Speaking rate multiplier (0.5–2.0).                |
| `modelQuantization`              | enum    | `q8`               | `q8` / `fp32` ONNX weights (size vs. quality).     |
| `normalization.enabled`          | boolean | `true`             | Master switch for text normalization.              |
| `normalization.backend`          | enum    | `cli-auto`         | `cli-auto` / `cli` / `api` / `none` (§6.6).        |
| `normalization.command`          | string  | `""`               | Explicit CLI command for `cli` backend (e.g. `claude`, `codex`). |
| `normalization.model`            | string  | `claude-haiku-4-5` | Model id for `api` backend (and CLI where settable).|
| `normalization.apiKey`           | secret  | —                  | `api` backend only; stored in VS Code SecretStorage.|
| `normalization.rules`            | string  | (seed rules)       | Natural-language rule set; user-editable.          |
| `highlightSentence`              | boolean | `true`             | Highlight the sentence being spoken.               |

- The default `cli-auto` backend needs **no key** — it reuses an installed
  `claude`/`codex` CLI's existing auth.
- The **API key (for the `api` backend) is stored in VS Code SecretStorage**,
  never in plaintext settings.
- `normalization.rules` ships with a sensible default set (the table in §6.1) and
  is fully editable by the user.

## 8. Performance targets

- **Time-to-first-audio** (warm model, cached/normalized): < 1.5 s.
- **Normalization latency** per sentence (LLM, cache miss): < 800 ms typical.
- **Cold start** (first run, model download): show progress; one-time ≈ 80–90 MB.
- Streaming keeps the audio queue ahead of playback so there are no mid-document
  stalls for typical paragraph-length text.

## 9. Voices & languages

- v1 ships English voices (American + British), e.g. `af_heart`, `af_bella`,
  `am_michael`, `bf_emma`, `bm_george` (final list pinned to the kokoro-js voice
  pack at build time).
- **Stretch:** Kokoro's other-language voices, gated by g2p availability.

## 10. Error handling & edge cases

- **No backend available** (CLI not installed, no key, offline): prompt once to
  pick a backend or fall back to deterministic; remember the choice.
- **CLI process hang/crash:** timeout → restart the warm process once → fall back
  to deterministic for that span; surface a subtle status note.
- **Offline:** deterministic fallback; surface a subtle status note.
- **Model download fails:** retry with backoff; actionable error with a link.
- **Very large selection:** cap with a warning + “speak anyway” option; stream.
- **Unsupported characters / emoji:** strip or describe per rules.
- **Rapid re-trigger:** new speak request cancels the in-flight one cleanly.

## 11. Packaging & distribution

- Host inference bundles **native binaries** (`onnxruntime-node`) plus
  `@huggingface/transformers`, so a single-platform VSIX is **~300 MB**. For
  Marketplace distribution this needs **per-platform targets**
  (`vsce package --target <platform>`) and trimming other-platform binaries /
  unused ORT-web assets. **Open issue.**
- Local development/use is via **F5** (deps resolve from `node_modules`), which is
  unaffected by the VSIX size.
- Model weights are **downloaded on first use** (not bundled), cached under the
  HuggingFace cache dir.
- License compliance: Kokoro is Apache-2.0; attribute the model + kokoro-js.

## 12. Decisions & open questions

Resolved:

- **A. Inference + playback → host (final).** Both run in the extension host:
  kokoro-js via `onnxruntime-node` for synthesis, the OS audio player for output.
  Evolution: webview Web-Audio → host playback + webview synthesis → all-host
  (this) — each step removed a class of problem (autoplay, focus, then WASM speed
  and the panel itself).
- **B. Model delivery → download-on-first-use**, cached after. With host
  inference the *runtime* ships in the VSIX as native binaries (large; §11);
  model weights still download once.
- **C. Highlighting → sentence-level** for v1 (word-level needs Kokoro timestamps).
- **D. Normalization backend → pluggable, CLI-agent default** (§6.6). Reuses an
  installed `claude`/`codex` CLI's auth so there's no API key to manage; `api`
  and `none` backends remain available.

Still open:

- **E. Warm-process protocol per CLI:** confirm `claude` streaming-JSON stdin and
  the equivalent for `codex`; if a CLI only supports one-shot `exec`, measure
  whether per-call spawn latency is acceptable behind cache + look-ahead.
- **F. Normalization granularity:** per-sentence vs. per-paragraph batching for
  the best latency/cost balance.
- **G. CLI sandboxing details:** exact flags per CLI to guarantee no file/tool
  access and no workspace context leakage.

## 13. Milestones

1. **M1 — Synthesis spike** ✅ kokoro-js in a webview, speak a hardcoded string.
2. **M2 — Editor integration** ✅ speak selection/document, status bar, stop,
   context menu; host-side playback via the OS audio player.
3. **M5 — Streaming playback** ✅ (partial) `tts.stream()` sentence chunks played
   in order so long text isn't truncated and audio starts early. Remaining for
   M5: **sentence highlighting** in the editor.
4. **M6 — Settings & voices** ✅ (partial) `kokoroSpeak.voice` + `kokoroSpeak.speed`
   settings and a **Select Voice** picker. Remaining: rules editor, secrets.
5. **M3 — Deterministic normalization:** offline rule engine + gating.
6. **M4 — LLM normalization agent:** pluggable backends (CLI-agent default with
   warm process + sandboxing, plus `api`), caching, opt-in, fallback.
7. **M5 (rest) — Sentence highlighting:** highlight the sentence being spoken.
8. **M7 — Package & publish:** docs, attribution, Marketplace listing. (VSIX
   packaging already in place — `npm run package`.)
