# Kokoro Speak (VS Code)

Read text aloud in any editor using the open-weight
[Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS model, with an
LLM-driven step that rewrites text into a speech-friendly form first.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full design.

## Status

### M1 — synthesis spike (done)

Proved Kokoro synthesizes in both the Node and in-browser (webview) paths.

- **Node path** (`onnxruntime-node`, `device: "cpu"`): model loads, generates
  audio at ~3x realtime, writes a valid 24kHz WAV.
- **Browser/webview path** (`onnxruntime-web`, `device: "wasm"`): runs in a real
  headless Chromium — model fetched from HuggingFace, ONNX-Runtime-Web compiled,
  workers spawned, valid WAV produced, no console errors.

```
{"status":"ok","loadMs":2855,"genMs":5194,"seconds":3.08,"sampleRate":24000,"wavBytes":295244,"voices":28}
```

### Round-trip verification (done)

`npm test` runs a partial end-to-end check: **text → Kokoro TTS → audio → local
Whisper (whisper-base.en) → text**, asserting word-level match. This proves the
speech is intelligible, not just non-empty. All local, no API key.

> Finding: both whisper base.en and small.en mishear the brand name "Kokoro"
> (an out-of-vocab proper noun) — a verifier limitation, not a synthesis defect.
> The suite asserts ordinary words survive the round-trip and documents this.

### M2 — editor integration (done; webview path verified headless)

Commands: **Speak Selection** (`Cmd/Ctrl+Alt+S`, empty selection → whole doc),
**Speak Document**, **Pause/Resume** (`Cmd/Ctrl+Alt+P`), **Stop**
(`Cmd/Ctrl+Alt+X`), plus a right-click "Speak Selection" entry and a status-bar
item that reflects state and stops on click.

Verified in a headless browser against the real `media/main.js`:
`loading → synthesizing → speaking → done`, and **Stop cancels in-flight
synthesis** (generation token prevents a cancelled request from ever playing).

> Not yet verified: the VS Code Extension Host UI itself (needs `F5` — there's no
> `code` CLI here). The headless browser test exercises the webview's synthesis +
> playback state machine, which is the substantive part.

### Webview fixes (after first real install)

Two issues only the real VS Code webview surfaced, now fixed and re-verified
headless under a CSP that mirrors the extension's:

- **ONNX-Runtime-Web load failed under CSP.** transformers.js dynamically imports
  its wasm loader from the jsdelivr CDN, which the webview `script-src` blocks
  ("no available backend found"). Fixed by **hosting ORT locally**: `npm run
  copy:ort` copies `ort-wasm-simd-threaded.jsep.{mjs,wasm}` into `media/ort/`,
  the host injects that URI via `<body data-ort-base>`, and the webview points
  `env.backends.onnx.wasm.wasmPaths` there (single-threaded — webviews aren't
  cross-origin isolated). No CDN, works offline once the model is cached.
- **Markdown preview did nothing.** A preview pane is a webview, not a text
  editor, so the keybinding's `editorTextFocus` clause never fired and
  `activeTextEditor` was undefined. Fixed: dropped the `when` clause and added a
  fallback that speaks the underlying document, stripping Markdown syntax first
  (`src/textprep.ts`) so it doesn't read "hash" / "asterisk" aloud.

## Layout

| Path                   | What                                                         |
|------------------------|-------------------------------------------------------------|
| `scripts/spike.mjs`    | Node synthesis spike → writes `out/spike.wav`.              |
| `src/extension.ts`     | Extension host: `Kokoro Speak: Speak Hello` command.        |
| `webview/main.ts`      | Webview: loads Kokoro (WASM), synthesizes, plays audio.     |
| `webview/browsertest.ts` + `test/harness.html` | Headless-browser check of the WASM inference path. |
| `test/m2harness.html`  | Headless-browser harness for the M2 webview state machine.  |
| `test/roundtrip.test.mjs` + `test/lib/` | Round-trip TTS↔ASR verification (`npm test`). |

## Run it

```bash
npm install            # native postinstalls (onnxruntime-node, esbuild) must be approved
npm run spike          # Node synthesis → out/spike.wav (open to hear it)
npm run build          # bundle extension host + webview
# then press F5 in VS Code → "Run Kokoro Speak (Extension)"
# in the dev host, run the command: "Kokoro Speak: Speak Hello (M1 spike)"
```

> First model run downloads ~80–90MB (q8 ONNX) and caches it.

## Next: M2

Editor integration — speak the current selection / whole document, status bar
state, and stop. See milestones in [REQUIREMENTS.md](REQUIREMENTS.md#13-milestones).
