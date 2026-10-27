import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const code = (await build({ entryPoints: ["chrome/src/offscreen/player.ts"], bundle: true, format: "cjs", write: false })).outputFiles[0].text;

test("Chrome: paused playback freezes highlights; Stop and drain suspend audio", async () => {
  let tick, ctx;
  const nodes = [];
  class AudioContext {
    state = "running";
    currentTime = 0;
    heard = 0;
    destination = {};
    constructor() { ctx = this; }
    async suspend() { this.state = "suspended"; }
    async resume() { this.state = "running"; }
    getOutputTimestamp() { return { contextTime: this.heard }; }
    createBuffer(_channels, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
    createBufferSource() {
      const node = { connect() {}, disconnect() { this.disconnected = true; }, start() {}, stop() { this.stopped = true; } };
      nodes.push(node);
      return node;
    }
  }
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, AudioContext, setInterval(f) { tick = f; return 1; }, clearInterval() {} });
  const player = new module.exports.Player(24);
  const clips = [];
  player.onClip = (c) => clips.push(c.index);
  player.enqueue(new Float32Array(24), { index: 0 });
  player.enqueue(new Float32Array(24), { index: 1 });
  ctx.heard = 0.5;
  tick();
  player.pause();
  ctx.heard = 1.5;
  tick();
  assert.deepEqual(clips, [0]);
  player.resume();
  tick();
  assert.deepEqual(clips, [0, 1]);
  const stopped = player.drained();
  player.stop();
  await stopped;
  assert.equal(ctx.state, "suspended");
  assert.ok(nodes[1].stopped && nodes[1].disconnected);
  ctx.currentTime = 2;
  player.enqueue(new Float32Array(24), { index: 2 });
  assert.equal(ctx.state, "running");
  const drained = player.drained();
  ctx.heard = 4;
  tick();
  await drained;
  assert.equal(ctx.state, "suspended");
});
