// Build a platform-specific VSIX for THIS machine (vsce --target <host>).
//
// The VSIX bundles native code — onnxruntime-node, audify, sharp — and npm only
// installs the host's native builds of audify/sharp, so a VSIX is only valid for
// the platform it was packaged on. onnxruntime-node, however, ships binaries for
// every platform (~200 MB+); we drop all but the host's so the VSIX stays lean.
// The static .vscodeignore can't express "everything except the host", so we
// write a temporary ignore file = .vscodeignore + the other platforms' dirs.
//
// Run: npm run package   (extra args are passed through to vsce)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VSCE_TARGETS = {
  "win32-x64": "win32-x64",
  "win32-arm64": "win32-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
};

const host = `${process.platform}-${process.arch}`;
const target = VSCE_TARGETS[host];
if (!target) {
  console.error(`[package] unsupported host platform: ${host}`);
  process.exit(1);
}

// Every onnxruntime-node binary dir (bin/napi-vN/<platform>/<arch>) that isn't ours.
const ortBin = join("node_modules", "onnxruntime-node", "bin");
const excludes = [];
if (existsSync(ortBin)) {
  for (const napi of readdirSync(ortBin)) {
    for (const plat of readdirSync(join(ortBin, napi))) {
      for (const arch of readdirSync(join(ortBin, napi, plat))) {
        if (plat !== process.platform || arch !== process.arch) {
          excludes.push(`node_modules/onnxruntime-node/bin/${napi}/${plat}/${arch}/**`);
        }
      }
    }
  }
} else {
  console.warn("[package] onnxruntime-node not installed — run npm install first");
}

const ignoreFile = join(tmpdir(), `kokoro-speak-vscodeignore-${process.pid}`);
writeFileSync(
  ignoreFile,
  readFileSync(".vscodeignore", "utf8") +
    `\n# Added by scripts/package.mjs for target ${target}\n` +
    excludes.join("\n") +
    "\n"
);

console.log(`[package] target ${target}; excluding ${excludes.length} other onnxruntime platform dir(s)`);
// npx resolves the local vsce (.cmd on Windows needs a shell).
const r = spawnSync(
  "npx",
  ["vsce", "package", "--target", target, "--ignoreFile", ignoreFile, ...process.argv.slice(2)],
  { stdio: "inherit", shell: process.platform === "win32" }
);
rmSync(ignoreFile, { force: true });
process.exit(r.status ?? 1);
