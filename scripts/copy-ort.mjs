// Copy the onnxruntime-web runtime files that transformers.js loads at runtime
// into media/ort/, so the webview can host them locally instead of fetching from
// the jsdelivr CDN (which the webview CSP blocks). Run as part of the build.

import { mkdir, copyFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@huggingface", "transformers", "dist");
const dst = join(root, "media", "ort");

const FILES = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

await mkdir(dst, { recursive: true });
for (const f of FILES) {
  const from = join(src, f);
  await stat(from); // fail loudly if the expected file moved between versions
  await copyFile(from, join(dst, f));
  console.log(`[copy-ort] ${f}`);
}
console.log(`[copy-ort] -> media/ort/`);
