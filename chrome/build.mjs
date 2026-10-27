// Builds the Chrome extension into chrome/dist (load it unpacked from there).
//   node chrome/build.mjs          → chrome/dist
//   node chrome/build.mjs --zip    → also kokoro-speak-chrome-<version>.zip, for the Chrome Web Store
//   node chrome/build.mjs --test   → chrome/dist-test, with access to 127.0.0.1 for chrome/test/e2e.mjs
//
// The extension is self-contained: the model, voices and runtime are bundled,
// so it works offline from the first use. Model files are hard-linked from
// models/, not copied.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeZip } from "../scripts/lib/archive.mjs";
import { iconPng } from "./icons.mjs";

const CHROME = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(CHROME);
const TEST = process.argv.includes("--test");
const ZIP = process.argv.includes("--zip");
const OUT = join(CHROME, TEST ? "dist-test" : "dist");
const MODEL = join(ROOT, "models", "kokoro-speak");
const WEB_DECODER = join(ROOT, "models", "kokoro-speak-web", "decoder.onnx");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function link(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to); // e.g. across volumes
  }
}

// 1. The model: the VS Code extension's, with a decoder that computes in fp32
//    (in fp16 on WebGPU, some words sound choppy; see tools/convert/upcast_decoder.py).
if (!existsSync(join(MODEL, "frontend.onnx"))) {
  console.error("[chrome] models/kokoro-speak is missing. Run `npm run prepare-model` first.");
  process.exit(1);
}
if (!existsSync(WEB_DECODER)) {
  const python = join(ROOT, ".venv-convert", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
  console.log("[chrome] converting the decoder for WebGPU (fp32 compute)…");
  mkdirSync(dirname(WEB_DECODER), { recursive: true });
  execFileSync(python, [join(ROOT, "tools", "convert", "upcast_decoder.py"), join(MODEL, "decoder.onnx"), WEB_DECODER], { stdio: "inherit" });
}

// 2. Code.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const common = {
  bundle: true,
  platform: "browser",
  target: "chrome121",
  logLevel: "warning",
  legalComments: "none",
  // kokoro-js only needs transformers.js to load its own model, which we don't.
  alias: { "@huggingface/transformers": join(CHROME, "src", "transformers-stub.ts") },
};
await build({
  ...common,
  format: "esm",
  entryPoints: ["background", "offscreen/offscreen", "popup", "options"].map((e) => join(CHROME, "src", `${e}.ts`)),
  entryNames: "[name]",
  outdir: OUT,
});
// Injected with chrome.scripting, which runs classic scripts only.
await build({ ...common, format: "iife", entryPoints: [join(CHROME, "src", "content.ts")], outfile: join(OUT, "content.js") });

// 3. Pages, manifest and icons.
for (const f of readdirSync(join(CHROME, "static"))) {
  if (f !== "manifest.json") copyFileSync(join(CHROME, "static", f), join(OUT, f));
}
const manifest = JSON.parse(readFileSync(join(CHROME, "static", "manifest.json"), "utf8"));
manifest.version = pkg.version;
// The e2e test can't click the toolbar, so it can't grant activeTab.
if (TEST) manifest.host_permissions = ["http://127.0.0.1/*"];
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
mkdirSync(join(OUT, "icons"));
for (const size of [16, 32, 48, 128]) writeFileSync(join(OUT, "icons", `icon-${size}.png`), iconPng(size));

// 4. Runtime, model, voices, notices.
const ortDist = join(ROOT, "node_modules", "onnxruntime-web", "dist");
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) link(join(ortDist, f), join(OUT, "ort", f));
link(join(MODEL, "frontend.onnx"), join(OUT, "models", "frontend.onnx"));
link(join(MODEL, "config.json"), join(OUT, "models", "config.json"));
link(join(MODEL, "manifest.json"), join(OUT, "models", "PROVENANCE.json"));
link(WEB_DECODER, join(OUT, "models", "decoder.onnx"));
// The voice list lives in src/core/voices.ts (TypeScript); read it from there.
const VOICES = [...readFileSync(join(ROOT, "src", "core", "voices.ts"), "utf8").matchAll(/"([ab][fm]_[a-z]+)"/g)].map((m) => m[1]);
for (const v of VOICES) link(join(ROOT, "node_modules", "kokoro-js", "voices", `${v}.bin`), join(OUT, "voices", `${v}.bin`));
copyFileSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));

// 5. Size, and the store package.
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
}
const all = files(OUT).sort();
const mb = all.reduce((n, f) => n + statSync(f).size, 0) / 1e6;
console.log(`[chrome] built ${relative(ROOT, OUT)} (v${pkg.version}, ${all.length} files, ${mb.toFixed(1)} MB)`);
if (ZIP) {
  const zip = join(ROOT, `kokoro-speak-chrome-${pkg.version}.zip`);
  writeFileSync(zip, writeZip(all.map((f) => ({ name: relative(OUT, f).split(sep).join("/"), data: readFileSync(f) }))));
  console.log(`[chrome] packaged ${relative(ROOT, zip)} (${(statSync(zip).size / 1e6).toFixed(1)} MB)`);
}
