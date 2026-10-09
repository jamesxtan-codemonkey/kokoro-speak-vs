// Fetch the Kokoro model files that ship inside the VSIX into ./models, laid out
// the way transformers.js resolves local models (env.localModelPath):
//   models/onnx-community/Kokoro-82M-v1.0-ONNX/{config.json, tokenizer*.json,
//                                                onnx/model_quantized.onnx}
// Pinned to a Hugging Face revision and verified by SHA-256, so a VSIX always
// carries exactly these bytes. Reuses a matching copy from the transformers.js
// download cache when there is one.
//
// Run: npm run fetch-model   (packaging runs it automatically)

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const MODEL_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";

/** Bundled files (q8 only — fp32/fp16 are downloaded on demand). */
export const MODEL_FILES = [
  { path: "config.json", sha256: "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f" },
  { path: "tokenizer.json", sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34" },
  { path: "tokenizer_config.json", sha256: "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20" },
  { path: "onnx/model_quantized.onnx", sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478" },
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MODELS_DIR = join(ROOT, "models");
const CACHE_DIR = join(ROOT, "node_modules", "@huggingface", "transformers", ".cache");

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function matches(file, sha256) {
  return existsSync(file) && (await sha256File(file)) === sha256;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const tmp = `${dest}.part`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, dest);
}

/** Ensure every bundled model file is present and verified. */
export async function fetchModel({ log = console.log } = {}) {
  for (const f of MODEL_FILES) {
    const dest = join(MODELS_DIR, MODEL_ID, f.path);
    if (await matches(dest, f.sha256)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    const cached = join(CACHE_DIR, MODEL_ID, f.path);
    if (await matches(cached, f.sha256)) {
      log(`[model] ${f.path}: copied from the transformers.js cache`);
      copyFileSync(cached, dest);
    } else {
      const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${f.path}`;
      log(`[model] ${f.path}: downloading ${url}`);
      await download(url, dest);
    }
    if (!(await matches(dest, f.sha256))) {
      rmSync(dest, { force: true });
      throw new Error(`[model] ${f.path}: SHA-256 mismatch after fetch`);
    }
  }
  log(`[model] ${MODEL_FILES.length} files verified in ${join("models", MODEL_ID)}`);
}

const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (isMain) {
  fetchModel().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
