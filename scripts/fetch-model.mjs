// Downloads the Kokoro model weights into ./model so they can be bundled in the
// VSIX for fully-offline use. Run automatically before packaging (build:vsix /
// vscode:prepublish). Skips files already present; pass --force to re-download.
//
// The voices ship inside the kokoro-js package, so only these four files (the
// q8 ONNX weights + configs/tokenizer) need fetching — keep this list in sync
// with REQUIRED_MODEL_FILES in src/synth.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "model");
const force = process.argv.includes("--force");

async function download(rel) {
  const out = path.join(dest, ...rel.split("/"));
  if (!force && fs.existsSync(out) && fs.statSync(out).size > 0) {
    console.log(`✓ ${rel} (cached)`);
    return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const url = `https://huggingface.co/${REPO}/resolve/main/${rel}?download=true`;
  process.stdout.write(`↓ ${rel} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)}MB`);
}

for (const rel of FILES) await download(rel);
console.log(`\nModel ready in ${dest}`);
