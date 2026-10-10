// Make sure models/kokoro-speak holds the converted Kokoro model the extension
// ships, converting it from the official weights if needed.
//
//   npm run prepare-model          # no-op when present and verified
//   npm run prepare-model -- --force
//
// The model is produced by tools/convert/convert.py (official hexgrad/Kokoro-82M
// weights at a pinned revision → validated ONNX). That needs Python 3.11–3.12; the
// script keeps its own virtualenv in .venv-convert (CPU-only torch, ~1 GB).
// Set PYTHON=/path/to/python to choose the interpreter.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MODEL_DIR = join(ROOT, "models", "kokoro-speak");
export const MODEL_FILES = ["frontend.onnx", "decoder.onnx", "config.json", "manifest.json"];
const VENV = join(ROOT, ".venv-convert");
const TORCH = "torch==2.14.1";
const TORCH_INDEX = "https://download.pytorch.org/whl/cpu";

export function sha256File(file) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", rej).on("end", () => res(h.digest("hex")));
  });
}

/** Verify models/kokoro-speak against its manifest. Returns a problem or null. */
export async function checkModel(dir = MODEL_DIR) {
  for (const f of MODEL_FILES) if (!existsSync(join(dir, f))) return `${f} missing`;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  for (const [f, info] of Object.entries(manifest.files)) {
    if ((await sha256File(join(dir, f))) !== info.sha256) return `${f} does not match manifest.json`;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.error?.message})`);
}

function pythonVersion(cmd, pre = []) {
  const r = spawnSync(cmd, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The pins in tools/convert/requirements.txt bound this: numpy and onnxruntime
// need Python >= 3.11, kokoro (the official package the converter imports) < 3.13.
const PY_MINORS = [12, 11];

function isSupported(version) {
  const [major, minor] = (version ?? "0.0").split(".").map(Number);
  return major === 3 && PY_MINORS.includes(minor);
}

/** A Python 3.11–3.12 interpreter: $PYTHON, the py launcher, or python3.x. */
function findPython() {
  const local = process.env.LOCALAPPDATA ?? "";
  const launcher = join(local, "Programs", "Python", "Launcher", "py.exe");
  const win = process.platform === "win32";
  const candidates = [
    process.env.PYTHON && [process.env.PYTHON, []],
    ...(win ? PY_MINORS.flatMap((m) => [["py", [`-3.${m}`]], [launcher, [`-3.${m}`]]]) : []),
    ...(win ? PY_MINORS.map((m) => [join(local, "Programs", "Python", `Python3${m}`, "python.exe"), []]) : []),
    ...PY_MINORS.map((m) => [`python3.${m}`, []]),
    ["python3", []],
    ["python", []],
  ].filter(Boolean);
  for (const [cmd, pre] of candidates) {
    const v = pythonVersion(cmd, pre);
    if (isSupported(v)) return [cmd, pre, v];
  }
  return null;
}

function venvPython() {
  return process.platform === "win32" ? join(VENV, "Scripts", "python.exe") : join(VENV, "bin", "python");
}

export async function prepareModel({ force = false, log = console.log } = {}) {
  if (!force) {
    const problem = await checkModel();
    if (!problem) {
      log("[model] models/kokoro-speak verified against manifest.json");
      return;
    }
    log(`[model] ${problem} — converting from the official weights`);
  }
  const py = venvPython();
  if (existsSync(py)) {
    // A venv from an unsupported Python (e.g. an older run) can't install the pins.
    const v = pythonVersion(py);
    if (!isSupported(v)) {
      log(`[model] .venv-convert uses Python ${v ?? "(unrunnable)"}, need 3.11–3.12 — recreating it`);
      rmSync(VENV, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  if (!existsSync(py)) {
    const found = findPython();
    if (!found) {
      throw new Error(
        "Python 3.11 or 3.12 is needed to convert the Kokoro model (official PyTorch weights → ONNX); " +
          "3.13+ is too new for kokoro. Install 3.12 (e.g. `winget install Python.Python.3.12` / " +
          "`brew install python@3.12`) or set PYTHON."
      );
    }
    const [cmd, pre, v] = found;
    log(`[model] creating .venv-convert with Python ${v}`);
    run(cmd, [...pre, "-m", "venv", VENV]);
  }
  run(py, ["-m", "pip", "install", "-q", "--upgrade", "pip"]);
  run(py, ["-m", "pip", "install", "-q", TORCH, "--index-url", TORCH_INDEX]);
  run(py, ["-m", "pip", "install", "-q", "-r", join(ROOT, "tools", "convert", "requirements.txt")]);
  rmSync(MODEL_DIR, { recursive: true, force: true });
  run(py, [join(ROOT, "tools", "convert", "convert.py"), "--out", MODEL_DIR], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_SYMLINKS_WARNING: "1", PYTHONWARNINGS: "ignore" },
  });
  const problem = await checkModel();
  if (problem) throw new Error(`[model] conversion finished but ${problem}`);
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (isMain) {
  prepareModel({ force: process.argv.includes("--force") }).catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
