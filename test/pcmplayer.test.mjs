// Unit tests for the pure helpers of the PCM streaming player (WAV parsing and
// resampling). The audify device path needs real audio hardware, so it's covered
// by the manual F5 / probe rather than here. Module bundled to test/.pcmplayer.cjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readWav, resample } = require("./.pcmplayer.cjs");

// Build a 16-bit PCM mono WAV the same way encodeWavPCM16 does.
function makeWav(samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

test("readWav round-trips rate and samples", () => {
  const src = [0, 1, -1, 100, -32768, 32767, 12345];
  const wav = makeWav(src, 24000);
  const { samples, rate } = readWav(wav);
  assert.equal(rate, 24000);
  assert.deepEqual(Array.from(samples), src);
});

test("resample 24k→48k doubles length and interpolates", () => {
  const src = Int16Array.from([0, 100, 200, 300]);
  const out = resample(src, 24000, 48000);
  assert.equal(out.length, 8); // 2x
  assert.equal(out[0], 0);
  assert.equal(out[2], 100); // original samples preserved at even indices
  assert.equal(out[4], 200);
  // interpolated midpoints sit between neighbours
  assert.ok(out[1] > 0 && out[1] < 100, `mid ${out[1]} not between 0 and 100`);
  assert.ok(out[3] > 100 && out[3] < 200, `mid ${out[3]} not between 100 and 200`);
});

test("resample is a no-op when rates match, and handles empty input", () => {
  const src = Int16Array.from([1, 2, 3]);
  assert.equal(resample(src, 48000, 48000), src); // same reference, no work
  assert.equal(resample(Int16Array.from([]), 24000, 48000).length, 0);
});

test("resample clamps to int16 range", () => {
  const out = resample(Int16Array.from([32767, -32768]), 24000, 48000);
  for (const v of out) assert.ok(v >= -32768 && v <= 32767, `out of range: ${v}`);
});
