// Verify a VSIX from scripts/package.mjs is self-contained for its target.
//
//   node scripts/verify-vsix.mjs <file.vsix> [--install]
//
// Always (any host): structure — the bundled model matches its SHA-256, native
// binaries exist for the target and are the right format/CPU (PE x64 /
// Mach-O arm64 / ELF), no other platform's binaries, sharp stubbed.
// When the VSIX targets this machine: extracts it and synthesizes speech from
// the extracted copy with downloads disabled (KOKORO_SPEAK_OFFLINE=1) — under
// Node and, if found, VS Code's own runtime (Electron) — and loads audify.
// --install: also installs it into a throwaway VS Code profile via the `code`
// CLI (proves VS Code accepts the package; your real setup is untouched).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_FILES, MODEL_ID } from "./fetch-model.mjs";
import { readZip } from "./lib/archive.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vsixPath = process.argv.slice(2).find((a) => !a.startsWith("--"));
const install = process.argv.includes("--install");
if (!vsixPath) {
  console.error("usage: node scripts/verify-vsix.mjs <file.vsix> [--install]");
  process.exit(2);
}

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`);
  if (!ok) failures++;
};

const zip = readZip(readFileSync(vsixPath));
const E = "extension/";
const has = (p) => zip.has(E + p);

// Target from the manifest.
const manifest = zip.get("extension.vsixmanifest").read().toString("utf8");
const target = manifest.match(/TargetPlatform="([^"]+)"/)?.[1];
check(!!target, `manifest declares a target platform (${target})`);
const [platform, arch] = (target ?? "-").split("-");
console.log(`\n${vsixPath}: ${target}, ${zip.size} files`);

// --- binary format helpers ---------------------------------------------------
function binaryKind(buf) {
  if (buf.readUInt16LE(0) === 0x5a4d) {
    const pe = buf.readUInt32LE(0x3c);
    const machine = buf.readUInt16LE(pe + 4);
    return { os: "win32", arch: { 0x8664: "x64", 0xaa64: "arm64", 0x14c: "ia32" }[machine] ?? machine };
  }
  if (buf.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4);
    return { os: "darwin", arch: { 0x0100000c: "arm64", 0x01000007: "x64" }[cpu] ?? cpu };
  }
  if (buf.readUInt32BE(0) === 0x7f454c46) {
    const machine = buf.readUInt16LE(18);
    return { os: "linux", arch: { 0x3e: "x64", 0xb7: "arm64" }[machine] ?? machine };
  }
  return { os: "unknown", arch: "unknown" };
}
function checkBinary(p) {
  const e = zip.get(E + p);
  if (!e) return check(false, `${p} present`);
  const k = binaryKind(e.read());
  check(k.os === platform && k.arch === arch, `${p} is ${k.os}-${k.arch}`);
}

// --- structure ----------------------------------------------------------------
console.log("\nstructure:");
check(has("package.json") && has("dist/extension.js"), "extension manifest + bundle");
const builtFor = has("package.json") && JSON.parse(zip.get(E + "package.json").read()).kokoroSpeakTarget;
check(builtFor === target, `package.json kokoroSpeakTarget = ${builtFor} (wrong-platform install guard)`);
for (const f of MODEL_FILES) {
  const e = zip.get(`${E}models/${MODEL_ID}/${f.path}`);
  const sha = e && createHash("sha256").update(e.read()).digest("hex");
  check(sha === f.sha256, `bundled model ${f.path} (${e ? (e.size / 1e6).toFixed(1) + " MB" : "missing"}) sha256`);
}
const voices = [...zip.keys()].filter((k) => k.startsWith(E + "node_modules/kokoro-js/voices/"));
check(voices.length >= 28, `kokoro voices bundled (${voices.length})`);

const ortDir = "node_modules/onnxruntime-node/bin/napi-v6";
const ortFiles = [...zip.keys()].filter((k) => k.startsWith(`${E}${ortDir}/`));
const foreign = ortFiles.filter((k) => !k.startsWith(`${E}${ortDir}/${platform}/${arch}/`));
check(ortFiles.length > 0 && foreign.length === 0, `onnxruntime binaries only for ${platform}/${arch} (${foreign.length} foreign)`);
checkBinary(`${ortDir}/${platform}/${arch}/onnxruntime_binding.node`);
if (platform === "win32") check(has(`${ortDir}/win32/${arch}/DirectML.dll`), "DirectML.dll (GPU)");
if (platform === "darwin") check(has(`${ortDir}/darwin/${arch}/libonnxruntime.1.dylib`), "libonnxruntime.1.dylib");

checkBinary("node_modules/audify/build/Release/audify.node");
const audifyLibs = [...zip.keys()].filter((k) => k.startsWith(E + "node_modules/audify/build/Release/"));
console.log(`        audify files: ${audifyLibs.map((k) => k.split("/").pop()).join(", ")}`);

check(
  zip.get(E + "node_modules/sharp/index.js")?.read().toString().includes("function sharp()"),
  "sharp is the stub"
);
const natives = [...zip.keys()].filter((k) => /\.(node|dll|dylib|so(\.\d+)*)$/.test(k));
const wrongNatives = natives.filter((k) => {
  const kind = binaryKind(zip.get(k).read());
  return kind.os !== platform || kind.arch !== arch;
});
check(wrongNatives.length === 0, `all ${natives.length} native binaries are ${target}` +
  (wrongNatives.length ? `: ${wrongNatives.map((k) => k.replace(E, "")).join(", ")}` : ""));

// --- runtime (host target only) ----------------------------------------------
const host = `${process.platform}-${process.arch}`;
if (target !== host) {
  console.log(`\nruntime: skipped (VSIX is ${target}, this machine is ${host})`);
} else {
  console.log("\nruntime (offline, from the extracted VSIX):");
  const dir = mkdtempSync(join(tmpdir(), "kokoro-speak-verify-"));
  try {
    for (const [name, e] of zip) {
      if (!name.startsWith(E)) continue;
      const dest = join(dir, name.slice(E.length));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, e.read());
    }
    // Build the real synth module INTO the extracted dist/, so its bundled-model
    // path resolution is exactly what dist/extension.js does.
    const smokeSynth = join(dir, "dist", "smoke-synth.cjs");
    const esbuild = spawnSync(
      process.execPath,
      [join(ROOT, "node_modules", "esbuild", "bin", "esbuild"), join(ROOT, "src", "synth.ts"),
        "--bundle", "--platform=node", "--format=cjs", `--outfile=${smokeSynth}`],
      { encoding: "utf8" }
    );
    check(esbuild.status === 0, "build smoke synth" + (esbuild.status ? `: ${esbuild.stderr}` : ""));
    const smoke = join(dir, "dist", "smoke.cjs");
    writeFileSync(
      smoke,
      `const S = require("./smoke-synth.cjs");
(async () => {
  const t0 = Date.now();
  await S.loadModel();
  let samples = 0, dur = 0;
  await S.synthesize("Self contained and offline.", {}, {
    onSegment: (wav, d) => { samples += (wav.length - 44) / 2; dur += d; },
    shouldCancel: () => false,
  });
  const a = require("audify");
  const rt = new a.RtAudio();
  const outs = rt.getDevices().filter((d) => d.outputChannels > 0).length;
  console.log(JSON.stringify({ backend: S.describeBackend(S.currentBackend()), seconds: +dur.toFixed(2), ms: Date.now() - t0, audioOutputs: outs }));
})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); });
`
    );
    const runtimes = [["node", process.execPath, {}]];
    const code = findVSCodeElectron();
    if (code) runtimes.push(["VS Code (Electron)", code, { ELECTRON_RUN_AS_NODE: "1" }]);
    for (const [label, exe, env] of runtimes) {
      const r = spawnSync(exe, [smoke], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...env, KOKORO_SPEAK_OFFLINE: "1" },
        timeout: 300000,
      });
      const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("{"));
      const res = line ? JSON.parse(line) : { error: (r.stderr || "no output").slice(-400) };
      check(!res.error && res.seconds > 0.5, `${label}: ${res.error ?? `spoke ${res.seconds}s on ${res.backend} in ${res.ms}ms, ${res.audioOutputs} audio output(s)`}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (install) {
  console.log("\ninstall (throwaway VS Code profile):");
  const cli = findCodeCli();
  if (!cli) check(false, "`code` CLI not found");
  else {
    const prof = mkdtempSync(join(tmpdir(), "kokoro-speak-install-"));
    try {
      const args = ["--extensions-dir", join(prof, "ext"), "--user-data-dir", join(prof, "data"),
        "--install-extension", resolve(vsixPath)];
      // code.cmd needs a shell on Windows; quote everything (paths have spaces).
      const r = process.platform === "win32"
        ? spawnSync([cli, ...args].map((a) => `"${a}"`).join(" "), { encoding: "utf8", shell: true, timeout: 300000 })
        : spawnSync(cli, args, { encoding: "utf8", timeout: 300000 });
      const lines = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/);
      const out = lines.find((l) => /installed/i.test(l)) ?? lines.pop();
      check(r.status === 0 && /successfully installed/i.test(`${r.stdout}${r.stderr}`), `code --install-extension: ${out}`);
    } finally {
      rmSync(prof, { recursive: true, force: true });
    }
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);

function findVSCodeElectron() {
  const c = process.platform === "win32"
    ? [join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"), join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "Code.exe")]
    : process.platform === "darwin"
      ? ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron", "/Applications/Visual Studio Code.app/Contents/MacOS/Code"]
      : ["/usr/share/code/code"];
  return c.find((p) => p && existsSync(p));
}

function findCodeCli() {
  const c = process.platform === "win32"
    ? [join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "bin", "code.cmd"), join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "bin", "code.cmd")]
    : ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/usr/bin/code", "/usr/local/bin/code"];
  return c.find((p) => p && existsSync(p));
}
