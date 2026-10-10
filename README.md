# Kokoro Speak

Read text aloud in VS Code with the official **Kokoro-82M** voice: natural,
fully offline, and GPU-accelerated on Windows.

Select some text and press **Ctrl+Alt+S** (**Cmd+Alt+S** on macOS). Kokoro Speak
reads it in one of 28 natural-sounding voices. Everything runs on your machine:
no account, no API key, no internet connection, and your text never leaves your
computer.

## Features

- **Speak a selection, a whole document, or the clipboard.** With nothing
  selected, Speak Selection reads the whole file.
- **Speak from anywhere**, including Markdown previews and chat panels such as
  Claude Code: copy the text, then press **Ctrl+Alt+V**.
- **Markdown reads naturally.** Headings, emphasis, links and code markers are
  stripped, so you hear the words, not the syntax.
- **Numbers and symbols read naturally.** `$10B` becomes "10 billion dollars",
  `v1.2.3` becomes "version 1 point 2 point 3", `Q4 2025` becomes "fourth
  quarter 2025". Add your own pronunciations, such as `K8s` → "Kubernetes".
- **Instant controls.** Pause, resume and stop take effect immediately, and
  playback is gapless between sentences.
- **Fast.** Speech starts in under half a second on a Windows GPU, and long
  documents stream sentence by sentence.

## Getting started

1. Install the extension.
2. Select text in any editor and press **Ctrl+Alt+S** / **Cmd+Alt+S**.
3. Press **Ctrl+Alt+P** to pause or resume, and **Ctrl+Alt+X** to stop.

The first time you speak, the model takes a second or two to load; after that
it stays ready.

## Commands and shortcuts

| Command | Windows | macOS |
|---|---|---|
| Kokoro Speak: Speak Selection (whole file if nothing is selected) | Ctrl+Alt+S | Cmd+Alt+S |
| Kokoro Speak: Speak Clipboard | Ctrl+Alt+V | Cmd+Alt+V |
| Kokoro Speak: Pause / Resume | Ctrl+Alt+P | Cmd+Alt+P |
| Kokoro Speak: Stop | Ctrl+Alt+X | Cmd+Alt+X |
| Kokoro Speak: Speak Document | | |
| Kokoro Speak: Select Voice | | |
| Kokoro Speak: Configure (AI) | | |

**Speak Selection** is also on the editor's right-click menu.

**The status bar** shows what Kokoro Speak is doing (loading, synthesizing,
speaking, paused). Click it to pause or resume, or, when idle, to speak the
clipboard. Hover over it for **Speak clipboard**, **Pause/Resume**, **Stop** and
**Config**, plus where speech is running (GPU or CPU).

## Voices and speed

Run **Kokoro Speak: Select Voice** to choose from 28 voices. Voice ids start
with an accent and a gender: `a` = American, `b` = British; `f` = female,
`m` = male. For example, `af_heart` (the default) is an American female voice
and `bm_george` is a British male voice.

Set `kokoroSpeak.speed` from 0.5 (slower) to 2.0 (faster); 1.0 is normal.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `kokoroSpeak.voice` | `af_heart` | The voice (see above). |
| `kokoroSpeak.speed` | `1` | Speaking rate, 0.5–2.0. |
| `kokoroSpeak.device` | `auto` | Where speech is generated: `auto` (the GPU when available, on Windows), `gpu`, or `cpu`. |
| `kokoroSpeak.bufferSeconds` | `0` | `0` starts speaking after the first sentence. A larger value groups more audio per chunk. |
| `kokoroSpeak.normalization.mode` | `deterministic` | How text is rewritten for speech: `off`, `deterministic` (built-in rules, offline), or `ai` (see below). |
| `kokoroSpeak.normalization.replacements` | `[]` | Your own pronunciations, e.g. `{ "from": "K8s", "to": "Kubernetes" }`, or regex rules. |
| `kokoroSpeak.normalization.spellOut` | `[]` | Acronyms to read letter by letter, e.g. `["API", "LFP"]`. |

Settings work per user or per project (in `.vscode/settings.json`), so a
repository can carry its own pronunciations.

## Smarter rewriting with AI (optional)

With `kokoroSpeak.normalization.mode` set to `ai`, an AI model rewrites text for
speech using plain-language rules that you can edit
(`kokoroSpeak.normalization.rules`). This is **off by default** and asks before
first use, because the text you speak is sent to the model. It uses a local
`claude` or `codex` command-line tool if you have one, or the Claude API with
your key (**Kokoro Speak: Set Normalization API Key**). If the model isn't
available, the built-in offline rules are used instead.

**Kokoro Speak: Configure (AI)** lets you change settings by asking in plain
language, such as *"use a British male voice"* or *"talk a bit slower"*. It
shows you the proposed changes before applying them.

## Platforms

| Platform | Support |
|---|---|
| Windows x64 | Supported. Speech is generated on the GPU through DirectML (any DirectX 12 GPU: NVIDIA, AMD or Intel, integrated included; no CUDA install needed), with automatic fallback to the CPU. |
| macOS on Apple silicon | Supported, on the CPU. |
| macOS on Intel, Linux, Windows on ARM | Not supported by the current release. |

On Windows, if the GPU can't be used (for example over Remote Desktop or after a
driver problem), Kokoro Speak switches to the CPU, tells you once, and keeps
speaking.

## Privacy

Speech is generated entirely on your computer. Nothing is downloaded or sent
anywhere while you use the extension, unless you turn on the optional AI
rewriting described above.

## The voice model

Kokoro Speak uses the official
[Kokoro-82M v1.0](https://huggingface.co/hexgrad/Kokoro-82M) model by hexgrad
(Apache-2.0), included in the extension. It's converted from the original
weights, and the conversion is only accepted if its output matches the official
model, so it sounds like the original, not like an approximation. The details, including how
it compares with other conversions, are in the
[developer guide](docs/DEVELOPMENT.md#the-model).

## For AI agents (MCP)

Kokoro Speak also comes as a standalone [MCP](https://modelcontextprotocol.io)
server, so agents such as Claude Code, Codex or Claude Desktop can speak their
replies aloud. See [docs/mcp-voice.md](docs/mcp-voice.md).

## Contributing

Building, packaging and the model conversion are described in the
[developer guide](docs/DEVELOPMENT.md). Source:
[github.com/jamesxtan-codemonkey/kokoro-speak-vs](https://github.com/jamesxtan-codemonkey/kokoro-speak-vs)

## License

The extension is [MIT](LICENSE). The Kokoro-82M model and voices are
[Apache-2.0](https://huggingface.co/hexgrad/Kokoro-82M).
