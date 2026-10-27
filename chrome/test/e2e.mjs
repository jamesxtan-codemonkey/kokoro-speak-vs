// End-to-end test of the built extension (chrome/dist-test) in Chrome for
// Testing: speak a selection with highlighting, pause/resume/stop, read a page,
// and the AI rewriting check against Anthropic. Also saves Chrome Web Store
// screenshots and promo tiles to chrome/test/out/.
//
//   npm run test:chrome                     (builds dist-test first)
//   CHROME_PATH=/path/to/chrome npm run test:chrome
//   AUDIBLE=1 npm run test:chrome           (hear it; muted by default)
//
// Google Chrome itself no longer accepts --load-extension, hence Chrome for
// Testing (Playwright's download is found automatically on macOS).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist-test");
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
  for (const d of dirs) {
    const p = join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    if (existsSync(p)) return p;
  }
  throw new Error("Chrome for Testing not found: set CHROME_PATH");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// Serve the fixtures. 127.0.0.1 matches the test build's host permission.
const server = createServer((req, res) => {
  const file = join(HERE, "fixtures", new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "article.html");
  if (!file.startsWith(join(HERE, "fixtures")) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), "kokoro-e2e-"));
let ctx;

let failures = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failures++;
    console.log(`✖ ${name}\n  ${e.stack?.split("\n").slice(0, 3).join("\n  ")}`);
  }
}

try {
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath(),
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      ...(process.env.AUDIBLE ? [] : ["--mute-audio"]),
    ],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`${BASE}/article.html`);
  const tabId = await sw.evaluate(async (base) => (await chrome.tabs.query({ url: `${base}/*` }))[0].id, BASE);

  const state = () => sw.evaluate(() => globalThis.kokoro.getState());
  // The highlight lives in the page's highlight registry, shared by all worlds.
  const highlighted = () => page.evaluate(() => [...(CSS.highlights.get("kokoro-speak") ?? [])].map((r) => r.toString()).join(""));

  /** Distinct highlights, in order, until playback is idle again. */
  async function highlightsUntilIdle(timeoutMs = 120000) {
    const seen = [];
    const t0 = Date.now();
    let started = false;
    for (;;) {
      const [s, h] = await Promise.all([state(), highlighted()]);
      if (h && h !== seen.at(-1)) seen.push(h);
      if (s.status === "speaking") started = true;
      if (s.status === "error") throw new Error(`error state: ${s.message}`);
      if (started && s.status === "idle") return seen;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out; saw ${JSON.stringify(seen)} last state ${JSON.stringify(s)}`);
      await sleep(50);
    }
  }

  await check("speak selection: highlights each sentence of the source, in order", async () => {
    await page.evaluate(() => {
      const t = document.getElementById("p1").firstChild;
      getSelection().setBaseAndExtent(t, 0, t, t.length);
    });
    const t0 = Date.now();
    await sw.evaluate((id) => globalThis.kokoro.speakSelection(id), tabId);
    const first = await until("first highlight", highlighted);
    console.log(`  first audio after ${((Date.now() - t0) / 1000).toFixed(1)} s (includes loading the model); backend: ${(await state()).backend}`);
    const seen = [first, ...(await highlightsUntilIdle())].filter((h, i, a) => h !== a[i - 1]);
    assert.deepEqual(seen, [
      "The quick brown fox jumps over the lazy dog.",
      // "e.g." doesn't end the sentence, and "$10B" stays as written on the page.
      "Revenue hit $10B in Q4 2025, e.g. more than ever.",
    ]);
    assert.equal(await until("highlight cleared", async () => (await highlighted()) === "" || null), true);
  });

  await check("CPU (WASM) setting: same speech and highlights without the GPU", async () => {
    await sw.evaluate(() => chrome.storage.sync.set({ device: "wasm" }));
    await page.evaluate(() => {
      const t = document.getElementById("p1").firstChild;
      getSelection().setBaseAndExtent(t, 0, t, t.length);
    });
    await sw.evaluate((id) => globalThis.kokoro.speakSelection(id), tabId);
    const seen = await highlightsUntilIdle();
    assert.equal((await state()).backend, "CPU (WASM)");
    assert.deepEqual(seen, ["The quick brown fox jumps over the lazy dog.", "Revenue hit $10B in Q4 2025, e.g. more than ever."]);
    await sw.evaluate(() => chrome.storage.sync.set({ device: "auto" }));
  });

  await check("read page: reads the article, skips page chrome, hidden text and footnote markers", async () => {
    const [{ result }] = await sw.evaluate(
      (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => window.__kokoroSpeak.extract("page") }),
      tabId
    );
    const lines = result.text.split("\n");
    assert.equal(lines[0], "Kokoro speaks the web");
    assert.ok(lines.includes("Reads the main article and skips the menus"));
    assert.ok(result.text.includes("Text with a link and some emphasis reads as one sentence."));
    for (const junk of ["Home", "Related reading", "Copyright", "Hidden text", "Screen reader only", "[1]"]) {
      assert.ok(!result.text.includes(junk), `should not read "${junk}"`);
    }
  });

  await check("pause freezes the highlight, resume continues, stop clears it", async () => {
    await page.evaluate(() => getSelection().removeAllRanges());
    await sw.evaluate((id) => globalThis.kokoro.readPage(id), tabId);
    await until("speaking", async () => (await state()).status === "speaking");
    await until("second sentence", async () => (await highlighted()).startsWith("The quick brown fox"));
    // Store screenshot: a sentence highlighted mid-article.
    await page.evaluate(() => document.getElementById("p2").scrollIntoView({ block: "center" }));
    await until("long paragraph", async () => (await highlighted()).startsWith("Every case figure"));
    await page.screenshot({ path: join(OUT, "screenshot-reading.png") });

    await sw.evaluate(() => globalThis.kokoro.togglePause());
    await until("paused", async () => (await state()).status === "paused");
    const held = await highlighted();
    await sleep(2500);
    assert.equal(await highlighted(), held, "highlight moved while paused");
    await sw.evaluate(() => globalThis.kokoro.togglePause());
    await until("resumed", async () => (await state()).status === "speaking");
    await until("next sentence after resume", async () => (await highlighted()) !== held, 30000);
    await sw.evaluate(() => globalThis.kokoro.stop());
    await until("idle", async () => (await state()).status === "idle");
    await until("highlight cleared", async () => (await highlighted()) === "");
  });

  await check("reading stops when its page reloads", async () => {
    await sw.evaluate((id) => globalThis.kokoro.readPage(id), tabId);
    await until("speaking", async () => (await state()).status === "speaking");
    await page.reload();
    await until("idle after reload", async () => (await state()).status === "idle", 10000);
  });

  await check("pages Chrome keeps extensions out of say so", async () => {
    const blocked = await ctx.newPage();
    await blocked.goto("chrome://version");
    await blocked.bringToFront();
    // (Looking it up by its chrome:// URL would need the "tabs" permission.)
    const id = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    await sw.evaluate((t) => globalThis.kokoro.readPage(t), id);
    const s = await until("error state", async () => {
      const st = await state();
      return st.status === "error" ? st : null;
    }, 10000);
    assert.equal(s.message, "Chrome doesn't let extensions read this page.");
    await blocked.close();
    // Errors clear themselves.
    await until("error cleared", async () => (await state()).status === "idle", 15000);
  });

  await check("selection in another site's frame: names the site and offers access", async () => {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/embedded.html`);
    const frame = await until("frame", async () => p.frames().find((f) => f.url().endsWith("/frame.html")));
    await frame.waitForSelector("p");
    await frame.evaluate(() => {
      window.focus();
      const t = document.querySelector("p").firstChild;
      getSelection().setBaseAndExtent(t, 0, t, t.length);
    });
    const id = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, p.url());
    const frameOrigin = new URL(frame.url()).origin;

    // Popup / shortcut: can't read the frame, so say where the text is.
    await sw.evaluate((t) => globalThis.kokoro.speakSelection(t), id);
    const s = await until("error", async () => {
      const st = await state();
      return st.status === "error" ? st : null;
    }, 10000);
    assert.match(s.message, new RegExp(`embedded frame from ${new URL(frameOrigin).host}`));
    assert.equal(s.needsAccess, frameOrigin);
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    assert.equal(await popup.textContent("#allow"), `Allow reading ${new URL(frameOrigin).host}`);
    assert.ok(await popup.isVisible("#allow"));
    await popup.close();

    // Right-click: speaks Chrome's copy of the selected text, and explains the missing highlight.
    await sw.evaluate(
      ([t, url]) => globalThis.kokoro.speakSelection(t, { frameId: 987654, frameUrl: url, fallbackText: "This paragraph lives in an embedded frame." }),
      [id, frame.url()]
    );
    const speaking = await until("speaking", async () => {
      const st = await state();
      return st.status === "speaking" ? st : null;
    });
    assert.match(speaking.message ?? "", /To highlight text in .* frames, allow access/);
    await sw.evaluate(() => globalThis.kokoro.stop());
    await until("idle", async () => (await state()).status === "idle");
    await p.close();
  });

  await check("options: AI rewriting reaches Anthropic from the browser", async () => {
    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html`);
    await opts.check('input[name="normMode"][value="ai"]');
    // Deliberately invalid: a rejection (not a network/CORS error) proves the round trip.
    await opts.fill("#apiKey", "sk-ant-e2e-invalid-key");
    await opts.click("#test-ai");
    const msg = await until("test result", async () => {
      const t = await opts.textContent("#test-result");
      return t && t !== "Asking Claude…" ? t : null;
    }, 30000);
    assert.equal(msg, "Anthropic rejected this API key.");
    await opts.fill("#apiKey", "");
    await opts.dispatchEvent("#apiKey", "change");
    await opts.check('input[name="normMode"][value="deterministic"]');
    await opts.evaluate(() => scrollTo(0, 0));
    await opts.screenshot({ path: join(OUT, "screenshot-options.png") });
    await opts.close();
  });

  await check("popup renders state and shortcuts", async () => {
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 300, height: 420 });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await until("status", async () => (await popup.textContent("#status")) === "Ready");
    assert.equal(await popup.textContent('kbd[data-command="speak-selection"]'), process.platform === "darwin" ? "⌥⇧S" : "Alt+Shift+S");
    assert.equal(await popup.locator("#voice option").count(), 28);
    const png = await popup.locator("body").screenshot();
    await popup.close();
    // Store screenshot: the popup over the page, as when opened from the toolbar.
    await page.evaluate((src) => {
      const img = Object.assign(document.createElement("img"), { src, id: "popup-shot" });
      Object.assign(img.style, { position: "fixed", top: "8px", right: "16px", width: "300px", boxShadow: "0 4px 24px rgba(0,0,0,.25)", borderRadius: "8px", zIndex: 9 });
      document.body.append(img);
    }, `data:image/png;base64,${png.toString("base64")}`);
    await sleep(300);
    await page.screenshot({ path: join(OUT, "screenshot-popup.png") });
    await page.evaluate(() => document.getElementById("popup-shot").remove());
  });

  await check("store promo tiles fill 440×280 and 1400×560", async () => {
    for (const [name, width, height] of [["promo-small", 440, 280], ["promo-marquee", 1400, 560]]) {
      const tile = await ctx.newPage();
      await tile.setViewportSize({ width, height });
      await tile.goto(pathToFileURL(join(HERE, "..", "store", `${name}.html`)).href);
      assert.deepEqual(await tile.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]), [width, height], name);
      await tile.screenshot({ path: join(OUT, `${name}.png`) });
      await tile.close();
    }
  });
} finally {
  try {
    await ctx?.close();
  } finally {
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
