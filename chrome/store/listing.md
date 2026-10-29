# Chrome Web Store listing

Copy these into the Developer Dashboard when uploading
`kokoro-speak-chrome-<version>.zip` (from `npm run chrome:package`).

## Store listing

**Name:** Kokoro Speak

**Summary** (132 characters max):

> Read web pages and selected text aloud in a natural voice, with each sentence highlighted. Private: runs on your device, offline.

**Category:** Accessibility

**Language:** English

**Description:**

> Kokoro Speak reads text aloud in a natural, human-sounding voice, right in your browser. Select some text and press Alt+Shift+S, or read a whole article with Alt+Shift+R. The sentence being spoken is highlighted on the page and kept in view, so you can follow along.
>
> It uses Kokoro-82M, an open speech model, running on your own computer: on the graphics card when one is available, otherwise on the processor. Nothing is sent to a server, there's no account, and it works offline. The voice model is included, so there's nothing more to download.
>
> Features
> • Speak the selected text, or read a page's main article and skip the menus, sidebars and footers.
> • Follow along: each sentence is highlighted as it's spoken.
> • 28 voices, American and British English, at any speed from 0.5× to 2×.
> • Pause, resume and stop instantly, from the toolbar, the right-click menu or the keyboard.
> • Numbers and symbols read naturally: "$10B" is read as "10 billion dollars" and "Q4 2025" as "fourth quarter 2025". Add your own pronunciations, and acronyms to spell out.
> • Optional AI rewriting with your own Anthropic API key, for text the built-in rules don't cover. It's off by default, and it's the only feature that sends text off your device.
>
> Shortcuts (change them at chrome://extensions/shortcuts)
> • Alt+Shift+S: speak the selection
> • Alt+Shift+R: read the page
> • Alt+Shift+P: pause or resume
> • Alt+Shift+X: stop

**Screenshots** (1280×800, made by `npm run test:chrome` in `chrome/test/out/`):

1. `screenshot-reading.png`: a sentence highlighted while reading an article
2. `screenshot-popup.png`: the toolbar popup
3. `screenshot-options.png`: the options page

**Promo tiles**, also in `chrome/test/out/`. Both are optional.

- Small (440×280): `promo-small.png`, rendered from
  [promo-small.html](promo-small.html). Listings without one are shown after
  those with one.
- Marquee (1400×560): `promo-marquee.png`, rendered from
  [promo-marquee.html](promo-marquee.html). Needed only to be considered for
  featuring at the top of the store.

**Additional fields** (all optional). The site is the repository's `gh-pages`
branch, served by GitHub Pages:

- **Homepage URL:** https://jamesxtan-codemonkey.github.io/kokoro-speak-vs/
- **Support URL:** https://jamesxtan-codemonkey.github.io/kokoro-speak-vs/support/
- **Official URL:** the same site, verified as yours in Google Search Console
  (URL-prefix property `https://jamesxtan-codemonkey.github.io/kokoro-speak-vs/`,
  by the `google-site-verification` meta tag in `index.html` on `gh-pages`).
  Keep the tag: removing it unverifies the site.

## Privacy practices

**Single purpose:** Reads text from web pages aloud with a text-to-speech
voice.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Reads the selected text, or the article, from the page the user asks it to read (via the menu, shortcut or popup), and highlights the sentence being spoken there. No access to other pages. |
| `scripting` | Injects the script that reads that page's text and draws the highlight, only into the tab the user invoked it on. |
| `contextMenus` | Adds "Speak selection", "Read this page aloud", and pause/stop to the right-click menu. |
| `offscreen` | The speech model runs and plays its audio in an offscreen document, because a service worker can't play audio or run the model. |
| `storage` | Saves the user's settings (voice, speed, pronunciations) and, only if they choose to use AI rewriting, their API key on their device. |
| Optional host permissions (`http://*/*`, `https://*/*`) | Requested for one site at a time, only when the user selects text inside an embedded frame from another site (which `activeTab` doesn't cover) and clicks "Allow reading <site>" in the popup. Used only to read the selected text in that frame and highlight it as it's spoken. Nothing is requested at install. |

**Remote code:** No. All code, the WebAssembly runtime and the model are in
the package. (The CSP allows `wasm-unsafe-eval` to run the bundled
WebAssembly.)

**Data usage:**

- *Website content:* the text being read is processed on the device. If the
  user turns on AI rewriting and enters their own Anthropic API key, the
  sentences containing numbers or symbols are sent to Anthropic's API to be
  rewritten for speech. Nothing is sent otherwise.
- *Authentication information:* the user's own Anthropic API key, if they
  enter one, is stored on their device and sent only to api.anthropic.com.
- No data is sold, used for advertising, or used for anything but reading
  the text aloud.

**Privacy policy URL:** https://jamesxtan-codemonkey.github.io/kokoro-speak-vs/privacy/
(the published copy of [privacy.md](privacy.md), on `gh-pages`: change both
together).
