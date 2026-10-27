import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import * as zlib from "node:zlib";
import { build } from "esbuild";
import { crc32, readZip, writeZip } from "../scripts/lib/archive.mjs";

test("zip writer preserves stored/deflated data, UTF-8 names and checksums", () => {
  const files = [
    { name: "empty.txt", data: Buffer.alloc(0) },
    { name: "données/voice.txt", data: Buffer.from("Hello, world. ".repeat(200)) },
    { name: "models/decoder.onnx", data: Buffer.from([0, 255, 128, 1, 2, 3]) },
  ];
  const zip = writeZip(files);
  assert.deepEqual(zip, writeZip(files));
  const entries = readZip(zip);
  let offset = 0;
  for (const f of files) {
    assert.deepEqual(entries.get(f.name).read(), f.data);
    assert.equal(zip.readUInt32LE(offset + 14), crc32(f.data));
    assert.equal(zip.readUInt16LE(offset + 6), 0x0800);
    offset += 30 + Buffer.byteLength(f.name) + zip.readUInt32LE(offset + 18);
  }
});

test("archive helpers still load on Node versions without zlib.crc32", async () => {
  const code = (await build({ entryPoints: ["scripts/lib/archive.mjs"], bundle: true, platform: "node", format: "cjs", write: false })).outputFiles[0].text;
  const module = { exports: {} };
  const oldZlib = { ...zlib };
  delete oldZlib.crc32;
  runInNewContext(code, { module, exports: module.exports, Buffer, require: () => oldZlib });
  const compat = module.exports;
  assert.equal(compat.crc32(Buffer.from("123456789")), 0xcbf43926);
  for (const data of [Buffer.alloc(0), Buffer.from("123456789"), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))]) {
    assert.equal(compat.crc32(data), crc32(data));
    assert.deepEqual(compat.writeZip([{ name: "test.bin", data }]), writeZip([{ name: "test.bin", data }]));
  }
});
