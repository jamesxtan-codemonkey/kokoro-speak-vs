// Smoke test for the Kokoro Speak MCP server: spawns the bundled stdio server
// and drives the JSON-RPC protocol. It does NOT call speak with valid input (that
// would load the model and play audio); it verifies wiring, tool list, schema
// validation, and list_voices. Model warm-up is disabled via env.
// Bundled to test/.mcp.cjs by `npm run test:build`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, ".mcp.cjs");
const PKG_VERSION = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8")
).version;

function startServer() {
  const srv = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, KOKORO_MCP_NO_WARM: "1" },
  });
  let buf = "";
  const pending = new Map();
  srv.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, resolve);
      const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
      pending.set(myId, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      srv.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n"
      );
    });
  const notify = (method, params) =>
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { srv, rpc, notify };
}

async function withServer(fn) {
  const s = startServer();
  try {
    const init = await s.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    s.notify("notifications/initialized", {});
    await fn({ ...s, init });
  } finally {
    s.srv.kill();
  }
}

test("MCP server initializes and reports its identity (version from package.json)", { timeout: 15000 }, async () => {
  await withServer(async ({ init }) => {
    assert.equal(init.result?.serverInfo?.name, "kokoro-speak");
    // version is sourced from package.json (single source of truth)
    assert.equal(init.result?.serverInfo?.version, PKG_VERSION);
  });
});

test("MCP server exposes speak, stop, list_voices", { timeout: 15000 }, async () => {
  await withServer(async ({ rpc }) => {
    const res = await rpc("tools/list", {});
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["list_voices", "speak", "stop"]);
    const speak = res.result.tools.find((t) => t.name === "speak");
    assert.ok(speak.inputSchema?.properties?.text, "speak takes a text arg");
    assert.ok(speak.inputSchema?.properties?.voice, "speak takes a voice arg");
  });
});

test("list_voices returns all 28 voices", { timeout: 15000 }, async () => {
  await withServer(async ({ rpc }) => {
    const res = await rpc("tools/call", { name: "list_voices", arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes("af_heart"));
    assert.ok(text.includes("bm_george"));
    assert.equal(text.trim().split("\n").length, 28);
  });
});

test("speak rejects a call with no text (schema validation, no model load)", { timeout: 15000 }, async () => {
  await withServer(async ({ rpc }) => {
    const res = await rpc("tools/call", { name: "speak", arguments: {} });
    // Either a protocol error or an isError tool result — both mean "rejected".
    const rejected = !!res.error || res.result?.isError === true;
    assert.ok(rejected, "missing text should be rejected by the input schema");
  });
});
