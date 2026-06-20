// Unit tests for the pure helpers of the PCM streaming player (WAV parsing and
// resampling). The audify device path needs real audio hardware, so it's covered
// by the manual F5 / probe rather than here. Module bundled to test/.pcmplayer.cjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readWav, resample, toChannelBytes, PcmStreamPlayer } = require("./.pcmplayer.cjs");

// A fake audify module: records device calls and lets the test drive the
// per-frame "finished playing" callback, so the streaming/pause logic can be
// tested without real audio hardware.
function fakeAudify() {
  const calls = { started: 0, stopped: 0, writes: 0, cleared: 0, closed: 0 };
  let frameCb = null;
  class RtAudio {
    getDefaultOutputDevice() {
      return 1;
    }
    getDevices() {
      return [{ id: 1, name: "fake", outputChannels: 2, sampleRates: [48000], preferredSampleRate: 48000 }];
    }
    openStream(_op, _ip, _fmt, _rate, _frame, _name, _inCb, outCb) {
      frameCb = outCb;
    }
    start() { calls.started++; }
    stop() { calls.stopped++; }
    write() { calls.writes++; }
    clearOutputQueue() { calls.cleared++; }
    closeStream() { calls.closed++; }
  }
  return {
    mod: { RtAudio, RtAudioFormat: { RTAUDIO_SINT16: 2 } },
    calls,
    playFrames: (n) => { for (let i = 0; i < n; i++) frameCb && frameCb(); },
  };
}

// 2880 samples @24k → 5760 @48k → exactly 6 frames of 960 samples. No leftover.
function sixFrameWav() {
  return makeWav(new Array(2880).fill(1000), 24000);
}

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

test("toChannelBytes duplicates mono to L+R for stereo (both speakers)", () => {
  const stereo = toChannelBytes(Int16Array.from([1, 2, 3]), 2);
  assert.equal(stereo.length, 3 * 2 * 2); // 3 samples × 2 ch × 2 bytes
  const got = [];
  for (let i = 0; i < stereo.length; i += 2) got.push(stereo.readInt16LE(i));
  assert.deepEqual(got, [1, 1, 2, 2, 3, 3]); // each sample on both channels
});

test("toChannelBytes leaves mono as-is for a 1-channel device", () => {
  const mono = toChannelBytes(Int16Array.from([5, -7]), 1);
  assert.equal(mono.length, 2 * 2);
  assert.deepEqual([mono.readInt16LE(0), mono.readInt16LE(2)], [5, -7]);
});

test("push writes frames ahead and starts the stream", () => {
  const { mod, calls } = fakeAudify();
  const p = PcmStreamPlayer.tryCreate({ onSpeaking() {}, onIdle() {}, onUnavailable() {} }, mod);
  assert.ok(p, "should create with the fake audify module");
  p.push(sixFrameWav(), 0.12);
  assert.equal(calls.started, 1, "started on first push");
  assert.equal(calls.writes, 6, "wrote all 6 frames ahead (gapless during synth)");
  assert.equal(p.isActive, true);
  p.stop();
});

test("pause clears the queue + stops; resume re-sends only the unplayed frames", () => {
  const { mod, calls, playFrames } = fakeAudify();
  const p = PcmStreamPlayer.tryCreate({ onSpeaking() {}, onIdle() {}, onUnavailable() {} }, mod);
  p.push(sixFrameWav(), 0.12); // 6 frames written
  playFrames(2); // device plays 2 frames

  assert.equal(p.togglePause(), "paused");
  assert.equal(p.isPaused, true);
  assert.equal(calls.cleared, 1, "pause cleared the output queue (instant silence)");
  assert.ok(calls.stopped >= 1, "pause stopped the stream");
  assert.equal(p.isActive, true, "still active while paused");

  const before = calls.writes; // 6
  assert.equal(p.togglePause(), "speaking");
  assert.equal(p.isPaused, false);
  assert.equal(calls.writes - before, 4, "resume re-sent exactly the 4 unplayed frames (2..6)");
  assert.ok(calls.started >= 2, "resume started the stream again");
  p.stop();
});

test("onIdle fires only after the final frame finishes playing", () => {
  const { mod, playFrames } = fakeAudify();
  let idled = false;
  const p = PcmStreamPlayer.tryCreate({ onSpeaking() {}, onIdle() { idled = true; }, onUnavailable() {} }, mod);
  p.push(sixFrameWav(), 0.12);
  p.end();
  assert.equal(idled, false, "not idle until frames play");
  playFrames(5);
  assert.equal(idled, false, "still one frame to go");
  playFrames(1);
  assert.equal(idled, true, "idle after all 6 frames played");
  assert.equal(p.isActive, false);
});

test("pause does not lose audio: total writes cover every frame exactly once after resume", () => {
  const { mod, calls, playFrames } = fakeAudify();
  const p = PcmStreamPlayer.tryCreate({ onSpeaking() {}, onIdle() {}, onUnavailable() {} }, mod);
  p.push(sixFrameWav(), 0.12); // frames 0..5 written once (6)
  playFrames(3); // 0,1,2 played
  p.togglePause(); // clears 3,4,5
  p.togglePause(); // re-writes 3,4,5 (3)
  assert.equal(calls.writes, 6 + 3, "frames 3,4,5 written again on resume — nothing skipped");
  p.stop();
});

test("stop closes the stream and goes inactive", () => {
  const { mod, calls } = fakeAudify();
  const p = PcmStreamPlayer.tryCreate({ onSpeaking() {}, onIdle() {}, onUnavailable() {} }, mod);
  p.push(sixFrameWav(), 0.12);
  p.stop();
  assert.ok(calls.closed >= 1, "stop closed the stream");
  assert.equal(p.isActive, false);
  assert.equal(p.isPaused, false);
});

test("tryCreate returns null when audify is unavailable (→ afplay fallback)", () => {
  assert.equal(PcmStreamPlayer.tryCreate({ onSpeaking() {}, onIdle() {}, onUnavailable() {} }, null), null);
});
