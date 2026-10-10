// Build a self-contained, platform-specific VSIX: extension + native runtime +
// the Kokoro model, so it installs and speaks offline with nothing to download.
//
//   node scripts/package.mjs                       # this machine's platform
//   node scripts/package.mjs --target darwin-arm64 # any target, from any host
//
// Why a staging dir: the VSIX's node_modules must hold the TARGET's native
// builds, but npm only installs the host's. So we copy the production
// dependency tree into a temp dir and fix it up for the target:
//   - onnxruntime-node ships every platform's binaries; keep only the target's.
//   - audify: swap in the target's prebuilt from its GitHub release.
//   - sharp: replace with a stub — transformers.js imports it at load (and
//     throws if it's missing) but only calls it for images, and its native
//     libvips is per-platform and ~20 MB.
// then run vsce there. The bundled model (official Kokoro-82M weights converted
// to ONNX, see tools/convert) comes from scripts/prepare-model.mjs.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareModel } from "./prepare-model.mjs";
import { untarGz } from "./lib/archive.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// VS Code target → node platform/arch. darwin-x64 is absent: onnxruntime-node
// 1.30 no longer ships Intel-macOS binaries.
const TARGETS = {
  "win32-x64": { platform: "win32", arch: "x64" },
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  "linux-arm64": { platform: "linux", arch: "arm64" },
};

// audify N-API build to bundle. N-API is forward-compatible, so pick a version
// every supported VS Code runtime has (engines ^1.90 → Electron 29 / Node 20,
// N-API 9) rather than the newest one npm happened to fetch for this Node.
const AUDIFY_NAPI = 8;

function parseArgs(argv) {
  const args = { target: undefined, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") args.target = argv[++i];
    else if (argv[i].startsWith("--target=")) args.target = argv[i].slice(9);
    else args.passthrough.push(argv[i]);
  }
  return args;
}

// npm is a .cmd shim on Windows and needs a shell; pass one pre-joined command
// string there (our args are fixed and space-free) rather than args + shell.
function shellSpawn(cmd, args, opts) {
  return process.platform === "win32" && opts.shell !== false
    ? spawnSync([cmd, ...args].join(" "), { ...opts, shell: true })
    : spawnSync(cmd, args, { ...opts, shell: false });
}

function run(cmd, args, opts = {}) {
  const r = shellSpawn(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
  return r;
}

/** Production dependency dirs (absolute), as npm resolved them. */
function prodDependencyDirs() {
  const r = shellSpawn("npm", ["ls", "--omit=dev", "--parseable", "--all"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && resolve(l) !== ROOT);
}

async function fetchAudifyPrebuilt(version, platform, arch) {
  const name = `audify-v${version}-napi-v${AUDIFY_NAPI}-${platform}-${arch}.tar.gz`;
  const cacheFile = join(ROOT, "node_modules", ".cache", "kokoro-speak-prebuilds", name);
  if (!existsSync(cacheFile)) {
    const url = `https://github.com/almoghamdani/audify/releases/download/v${version}/${name}`;
    console.log(`[package] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, Buffer.from(await res.arrayBuffer()));
  }
  return untarGz(readFileSync(cacheFile));
}

async function main() {
  const { target: requested, passthrough } = parseArgs(process.argv.slice(2));
  const target = requested ?? `${process.platform}-${process.arch}`;
  const t = TARGETS[target];
  if (!t) {
    console.error(`[package] unsupported target "${target}". Supported: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  console.log(`[package] ${pkg.name}@${pkg.version} for ${target}`);

  // 1. Build the extension bundle and make sure the model is present + verified.
  run("npm", ["run", "vscode:prepublish"], { cwd: ROOT });
  await prepareModel({ log: (m) => console.log(m) });

  // 2. Stage the extension files.
  const stage = mkdtempSync(join(tmpdir(), `kokoro-speak-pkg-${target}-`));
  try {
    for (const f of ["README.md", "LICENSE", ".vscodeignore", "dist/extension.js", "docs", "skills", "models/kokoro-speak"]) {
      if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(stage, f), { recursive: true });
    }
    // Already built above; the stage has no sources or dev tools to rebuild with.
    const stagedPkg = { ...pkg, scripts: { ...pkg.scripts } };
    delete stagedPkg.scripts["vscode:prepublish"];
    delete stagedPkg.devDependencies;
    // VS Code will install a VSIX built for another platform without complaint;
    // the extension checks this at activation and names the right file.
    stagedPkg.kokoroSpeakTarget = target;
    writeFileSync(join(stage, "package.json"), JSON.stringify(stagedPkg, null, 2) + "\n");

    // 3. Copy the production dependency tree, minus other platforms' binaries.
    const ortBin = join("node_modules", "onnxruntime-node", "bin") + sep;
    const keepOrt = `${sep}${t.platform}${sep}${t.arch}`;
    const deps = prodDependencyDirs();
    for (const dir of deps) {
      const rel = relative(ROOT, dir);
      if (rel.startsWith(join("node_modules", "@img") + sep)) continue; // sharp natives (stubbed)
      cpSync(dir, join(stage, rel), {
        recursive: true,
        filter: (src) => {
          const r = relative(ROOT, src);
          // nested node_modules are separate entries in `deps`; skip caches.
          if (r !== rel && r.slice(rel.length + 1).split(sep).includes("node_modules")) return false;
          if (r.split(sep).includes(".cache")) return false;
          if (r.startsWith(ortBin)) {
            // node_modules/onnxruntime-node/bin/napi-vN/<platform>/<arch>/...
            const parts = r.slice(ortBin.length).split(sep);
            if (parts.length >= 3 && `${sep}${parts[1]}${sep}${parts[2]}` !== keepOrt) return false;
            if (parts.length === 2 && parts[1] !== t.platform) return false;
          }
          return true;
        },
      });
    }
    console.log(`[package] staged ${deps.length} production packages`);

    // 4. audify: the target's prebuilt native addon.
    const audifyDir = join(stage, "node_modules", "audify");
    const audifyVer = JSON.parse(readFileSync(join(audifyDir, "package.json"), "utf8")).version;
    rmSync(join(audifyDir, "build"), { recursive: true, force: true });
    for (const f of await fetchAudifyPrebuilt(audifyVer, t.platform, t.arch)) {
      const dest = join(audifyDir, f.name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
    }
    if (!existsSync(join(audifyDir, "build", "Release", "audify.node"))) {
      throw new Error("audify prebuilt did not contain build/Release/audify.node");
    }

    // 5. sharp → stub with the same name/version (keeps `npm ls` consistent).
    const sharpDir = join(stage, "node_modules", "sharp");
    if (existsSync(sharpDir)) {
      const sharpVer = JSON.parse(readFileSync(join(sharpDir, "package.json"), "utf8")).version;
      rmSync(sharpDir, { recursive: true, force: true });
      mkdirSync(sharpDir, { recursive: true });
      writeFileSync(
        join(sharpDir, "package.json"),
        JSON.stringify({ name: "sharp", version: sharpVer, main: "index.js", license: "Apache-2.0" }, null, 2)
      );
      writeFileSync(
        join(sharpDir, "index.js"),
        "// Stub: Kokoro Speak never processes images. transformers.js requires a\n" +
          "// truthy `sharp` at load but only calls it for image inputs.\n" +
          "module.exports = function sharp() {\n" +
          '  throw new Error("Image processing is not bundled with Kokoro Speak.");\n' +
          "};\n"
      );
    }

    // 6. Package. vsce resolves dependencies with `npm list` in the stage.
    const out = join(ROOT, `${pkg.name}-${target}-${pkg.version}.vsix`);
    const vsce = join(ROOT, "node_modules", "@vscode", "vsce", "vsce");
    run(process.execPath, [vsce, "package", "--target", target, "--out", out, ...passthrough], {
      cwd: stage,
      shell: false,
    });
    console.log(`[package] verify with: node scripts/verify-vsix.mjs ${relative(ROOT, out)}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[package] ${e.message ?? e}`);
  process.exit(1);
});
