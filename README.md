# Kokoro Speak (VS Code)

Read text aloud in any editor using the open-weight
[Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS model, with an
LLM-driven step that rewrites text into a speech-friendly form first.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full design.

## Status: M1 — synthesis spike (done)

Goal of M1 was to prove Kokoro actually synthesizes in this environment, in both
the Node and the in-browser (webview) paths.

Verified:

- **Node path** (`onnxruntime-node`, `device: "cpu"`): model loads, generates
  audio at ~3x realtime, writes a valid 24kHz WAV.
- **Browser/webview path** (`onnxruntime-web`, `device: "wasm"`): runs in a real
  headless Chromium — model fetched from HuggingFace, ONNX-Runtime-Web compiled,
  workers spawned, valid WAV produced, no console errors.

```
{"status":"ok","loadMs":2855,"genMs":5194,"seconds":3.08,"sampleRate":24000,"wavBytes":295244,"voices":28}
```

## Layout

| Path                   | What                                                         |
|------------------------|-------------------------------------------------------------|
| `scripts/spike.mjs`    | Node synthesis spike → writes `out/spike.wav`.              |
| `src/extension.ts`     | Extension host: `Kokoro Speak: Speak Hello` command.        |
| `webview/main.ts`      | Webview: loads Kokoro (WASM), synthesizes, plays audio.     |
| `webview/browsertest.ts` + `test/harness.html` | Headless-browser check of the WASM inference path. |

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
