# Kokoro Speak for Chrome

The Chrome version of Kokoro Speak: reads selected text or a whole web page
aloud with the Kokoro-82M voice, highlighting each sentence as it's spoken.
Like the VS Code extension, it runs entirely on the user's machine (WebGPU,
or WebAssembly on the CPU) and works offline. The model ships inside the
extension.

## Build, load, test

Needs the converted model (`npm run prepare-model`, as for the VS Code
extension) and its conversion virtualenv, which the build uses once to make a
WebGPU-safe copy of the decoder (see [Decoder](#decoder)).

```bash
npm run chrome:build       # → chrome/dist: load it at chrome://extensions → Developer mode → Load unpacked
npm run chrome:package     # → also kokoro-speak-chrome-<version>.zip for the Chrome Web Store
npm run chrome:typecheck
npm run test:chrome        # end-to-end, in Chrome for Testing (see below)
```

The version comes from the root `package.json`, shared with the VS Code
extension.

`test:chrome` builds `chrome/dist-test` (the same extension, plus access to
`127.0.0.1` so the test can act without clicking the toolbar) and drives it in
Chrome for Testing with Playwright. Google Chrome ignores `--load-extension`,
so the test uses Playwright's Chrome for Testing download, which it finds on
macOS. Elsewhere, set `CHROME_PATH`. Audio is muted unless `AUDIBLE=1`. It
checks speaking a selection with highlights in order, the CPU path,
article extraction, pause/resume/stop, stopping on reload, restricted pages,
the AI-rewriting round trip to Anthropic (with a deliberately invalid key),
and the popup. It also saves Web Store screenshots to `chrome/test/out/`.

## How it works

| Part | File | Job |
|---|---|---|
| Service worker | `src/background.ts` | Menu, shortcuts, popup requests; reads text via the content script; relays highlights; keeps state (`chrome.storage.session`) and the badge |
| Offscreen document | `src/offscreen/` | Runs the model and plays audio (a service worker can do neither); one job at a time |
| Content script | `src/content.ts` | Injected on demand; selection or article → text with a per-character map to DOM text nodes; draws the highlight |
| Popup, options | `src/popup.ts`, `src/options.ts`, `static/` | Controls and settings (`chrome.storage.sync`; the API key in `chrome.storage.local`) |

Shared with the VS Code extension, in `src/core/`: chunking, the model-input
helpers, the voice list, and normalization (the built-in rules and the
Anthropic call). One fix lands in both.

**Highlighting.** Normalization rewrites text ("$10B" → "10 billion
dollars"), so the shared normalizer can return a `MappedText`, which records
which input characters each output character came from. The offscreen
document chunks the normalized text, maps each chunk back to the page text,
and reports that range when the chunk becomes audible (by the audio clock,
so pausing freezes it). The content script turns the range into a DOM
`Range` and highlights it with the CSS Custom Highlight API, which doesn't
touch the page's DOM.

**Reading a page.** The content script picks the article (`<article>`,
`<main>`, or the element whose paragraphs hold the most text), skips page
chrome (nav, aside, footer, forms, figures, footnote markers, hidden and
screen-reader-only text), and turns block elements into line breaks, which
the chunker treats as sentence breaks.

**Embedded frames.** The toolbar, shortcut and right-click grant `activeTab`,
which covers the page's own site only. A selection inside another site's
frame can't be read: the content script reports the focused frame's origin,
the popup offers "Allow reading <site>" (an optional host permission for
that one origin), and the right-click path speaks Chrome's copy of the
selected text without highlighting meanwhile.

**AI rewriting** calls the Anthropic API from the offscreen document with
the user's key, one chunk at a time as it's about to be read, and only for
chunks with numbers or symbols. Failures fall back to the built-in rules.

## Findings this design rests on

All measured on an Apple-silicon Mac (Chrome 153/156).

- **Speed.** WebGPU runs about 10× realtime with the fp32-compute decoder
  (native CPU in the VS Code extension: about 8×). The CPU path (WASM, 4
  threads) runs about 2.5×, still faster than speech. The first sentence
  after loading takes about 2 s.
- **Both halves on one backend.** A WASM frontend next to a WebGPU decoder
  slowed down about 6× after a few sentences, reproducibly. Both on WebGPU,
  or both on WASM, stayed steady.
- **The offscreen document isn't throttled.** Its speed was the same with
  Chrome in front or behind other windows, playing or silent. Chrome reports
  it as visible.
- **Offscreen lifetime.** Created with only `AUDIO_PLAYBACK`, Chrome closed
  it about 30 s after audio stopped, unloading the model. With `WORKERS` as
  well, it stays open, so the document closes itself after 10 idle minutes
  instead, to free the memory.
- **WASM build.** onnxruntime-web 1.30's WebGPU bundle loads only the
  `asyncify` WASM build. A missing build fails as "no available backend" and
  breaks every later session in that page.

### Decoder

`decoder.onnx` stores fp16 weights and computes in fp16. onnxruntime's CPU
backend has few fp16 kernels and computes in fp32 anyway, so it sounds right
natively. WebGPU computes in fp16 for real, and some words came out choppy.
`tools/convert/upcast_decoder.py` keeps the fp16 weights (same 107 MB) but
makes the graph compute in fp32. Measured as log-spectral distance from
native output: fp16 on WebGPU 6.9–9.3 dB (worst 19 dB), fp32 compute
2.2–2.3 dB, the same as WASM. `chrome/build.mjs` writes it to
`models/kokoro-speak-web/decoder.onnx` on first build.

The VS Code extension's DirectML path (Windows GPU) also runs this decoder
on a GPU, and may have the same problem. It hasn't been checked.

## Publishing

`npm run chrome:package` writes the store zip (about 266 MB, nearly all the
model). The listing text, permission justifications and data disclosures
are in [store/listing.md](store/listing.md), and the privacy policy is in
[store/privacy.md](store/privacy.md). The policy needs a public URL. The
store's upload size limit wasn't confirmed while this was written, so check
it on the first upload.
