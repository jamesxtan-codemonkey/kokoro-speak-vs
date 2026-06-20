import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { StreamPlayer } = require("./.player.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "kokoro-player-test-"));
}

// A fake player that records every spawn (file + timestamp) and exits after the
// segment's duration — so a segment's "audible" interval is [t, t + durMs]. With
// no startup latency, correctly-scheduled segments are back-to-back (no overlap);
// an overlap means two players are sounding at once = an echo.
function recordingResolver(spawns, durByFile) {
  return (file) => {
    spawns.push({ file, t: Date.now() });
    const durMs = durByFile.get(file) ?? 100;
    return [[process.execPath, ["-e", `setTimeout(() => {}, ${durMs})`]]];
  };
}

function addSeg(player, durByFile, file, durMs) {
  durByFile.set(file, durMs);
  player.add(file, durMs / 1000);
}

// Each file must be spawned exactly once (no double-play), and consecutive
// segments must not overlap (next starts >= the previous one's duration later,
// minus scheduling jitter). A shorter gap means overlapping audio = echo.
function assertNoEcho(spawns, durMs, tol = 30) {
  const counts = {};
  for (const s of spawns) counts[s.file] = (counts[s.file] ?? 0) + 1;
  for (const [file, n] of Object.entries(counts)) {
    assert.equal(n, 1, `segment "${file}" was spawned ${n} times (echo)`);
  }
  const sorted = [...spawns].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].t - sorted[i - 1].t;
    assert.ok(
      gap >= durMs - tol,
      `segments overlap by ${durMs - gap}ms (echo): "${sorted[i - 1].file}" → "${sorted[i].file}" only ${gap}ms apart`
    );
  }
}

test("stream player becomes inactive after the final segment drains", { timeout: 1000 }, async () => {
  const dir = tempDir();
  const wav = join(dir, "segment.wav");
  writeFileSync(wav, "not real audio; fake player ignores it");

  let idle;
  const player = new StreamPlayer(
    {
      onSpeaking() {},
      onIdle() {
        idle?.();
      },
      onUnavailable() {
        assert.fail("fake node player should be available");
      },
    },
    () => [[process.execPath, ["-e", "setTimeout(() => {}, 80)"]]]
  );

  const idlePromise = new Promise((resolve) => {
    idle = resolve;
  });
  player.add(wav, 0.005);
  player.end();

  await idlePromise;
  assert.equal(player.isActive, false);
  assert.equal(existsSync(wav), false);
  rmSync(dir, { recursive: true, force: true });
});

test("stop kills the actual fallback process after a missing player candidate", { timeout: 1000 }, async () => {
  const dir = tempDir();
  const wav = join(dir, "segment.wav");
  const marker = join(dir, "fallback-finished");
  writeFileSync(wav, "not real audio; fake player ignores it");

  const player = new StreamPlayer(
    {
      onSpeaking() {},
      onIdle() {},
      onUnavailable() {
        assert.fail("fallback node player should be available");
      },
    },
    () => [
      ["definitely-missing-kokoro-player", [wav]],
      [
        process.execPath,
        [
          "-e",
          "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 200)",
          marker,
        ],
      ],
    ]
  );

  player.add(wav, 1);
  await delay(50);
  player.stop();
  await delay(250);

  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(wav), false);
  rmSync(dir, { recursive: true, force: true });
});

test("immediate stop prevents a missing candidate from spawning its fallback", { timeout: 1000 }, async () => {
  const dir = tempDir();
  const wav = join(dir, "segment.wav");
  const marker = join(dir, "fallback-finished");
  writeFileSync(wav, "not real audio; fake player ignores it");

  const player = new StreamPlayer(
    {
      onSpeaking() {},
      onIdle() {},
      onUnavailable() {},
    },
    () => [
      ["definitely-missing-kokoro-player", [wav]],
      [
        process.execPath,
        [
          "-e",
          "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 100)",
          marker,
        ],
      ],
    ]
  );

  player.add(wav, 1);
  player.stop();
  await delay(200);

  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(wav), false);
  rmSync(dir, { recursive: true, force: true });
});

test("play: segments spawn once each, in order, gapless (no overlap)", { timeout: 2000 }, async () => {
  const dir = tempDir();
  const files = ["a", "b", "c"].map((n) => join(dir, `${n}.wav`));
  for (const f of files) writeFileSync(f, "fake");

  const spawns = [];
  const durByFile = new Map();
  let idle;
  const player = new StreamPlayer(
    { onSpeaking() {}, onIdle() { idle?.(); }, onUnavailable() { assert.fail("node player should exist"); } },
    recordingResolver(spawns, durByFile)
  );
  const idlePromise = new Promise((r) => (idle = r));

  for (const f of files) addSeg(player, durByFile, f, 100);
  player.end();
  await idlePromise;

  assert.equal(player.isActive, false);
  assert.deepEqual(spawns.map((s) => s.file), files); // spawned in order, once each
  assertNoEcho(spawns, 100);
  rmSync(dir, { recursive: true, force: true });
});

test("pause stops the audio immediately (kills the player, no bleed)", { timeout: 3000 }, async () => {
  const dir = tempDir();
  const wav = join(dir, "seg.wav");
  const marker = join(dir, "finished");
  writeFileSync(wav, "fake");

  // Fake player writes a marker when its audio "finishes" (after 250ms). Pause
  // kills it before then, so the marker is never written = audio stopped now.
  const player = new StreamPlayer(
    { onSpeaking() {}, onIdle() {}, onUnavailable() { assert.fail("node player should exist"); } },
    () => [[process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 250)", marker]]]
  );

  player.add(wav, 0.25);
  player.end();
  await delay(80); // mid-playback
  player.togglePause();
  assert.equal(player.isPaused, true);
  await delay(400); // past the 250ms "audio" — killed, so it never finishes

  assert.equal(existsSync(marker), false, "audio kept playing after pause");
  player.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("resume replays the current segment from its start", { timeout: 2000 }, async () => {
  const dir = tempDir();
  const wav = join(dir, "seg.wav");
  writeFileSync(wav, "fake");

  const spawns = [];
  const durByFile = new Map();
  const player = new StreamPlayer(
    { onSpeaking() {}, onIdle() {}, onUnavailable() { assert.fail("node player should exist"); } },
    recordingResolver(spawns, durByFile)
  );

  addSeg(player, durByFile, wav, 300);
  player.end();
  await delay(80);
  player.togglePause(); // kills the player (instant silence)
  await delay(120);
  player.togglePause(); // resume → replay the SAME segment from the start
  await delay(400);

  // Spawned twice: the initial play and the replay on resume — same file, so no
  // content is lost when resuming after an instant (kill-based) pause.
  assert.equal(spawns.length, 2, `expected 2 spawns (play + replay), got ${spawns.length}`);
  assert.ok(spawns.every((s) => s.file === wav));
  rmSync(dir, { recursive: true, force: true });
});

test("pause during a buffer underrun, then resume, does not double-spawn (echo regression)", { timeout: 3000 }, async () => {
  const dir = tempDir();
  const files = ["a", "b", "c"].map((n) => join(dir, `${n}.wav`));
  for (const f of files) writeFileSync(f, "fake");

  const spawns = [];
  const durByFile = new Map();
  const player = new StreamPlayer(
    { onSpeaking() {}, onIdle() {}, onUnavailable() { assert.fail("node player should exist"); } },
    recordingResolver(spawns, durByFile)
  );

  // 1) Play "a" and let playback drain past it → the player is now waiting on
  //    synthesis (buffer underrun): nothing playing, no segment queued.
  addSeg(player, durByFile, files[0], 100);
  await delay(220);
  // 2) Pause in that gap.
  player.togglePause();
  // 3) Synthesis catches up while paused.
  addSeg(player, durByFile, files[1], 100);
  await delay(30);
  // 4) Resume → schedules "b". (Bug: left `waiting` set.)
  player.togglePause();
  await delay(20);
  // 5) Next segment arrives. With the bug, `waiting` is still set, so this
  //    spawns "c" immediately — overlapping "b" → echo.
  addSeg(player, durByFile, files[2], 100);
  player.end();
  await delay(500);

  assertNoEcho(spawns, 100); // each once, and "b"/"c" not overlapping
  rmSync(dir, { recursive: true, force: true });
});

test("stop kills the currently playing segment immediately (no audio tail)", { timeout: 2000 }, async () => {
  const dir = tempDir();
  const wav = join(dir, "seg.wav");
  const marker = join(dir, "finished");
  writeFileSync(wav, "fake");

  // The fake player writes a marker when its "audio" finishes (after 300ms).
  // If stop kills it promptly, the marker is never written — playback ended.
  const player = new StreamPlayer(
    { onSpeaking() {}, onIdle() {}, onUnavailable() { assert.fail("node player should exist"); } },
    () => [[process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 300)", marker]]]
  );

  player.add(wav, 0.3);
  player.end();
  await delay(60); // mid-playback
  player.stop();
  await delay(400); // past the 300ms "audio"

  assert.equal(existsSync(marker), false, "playing segment kept going after stop");
  assert.equal(player.isActive, false);
  assert.equal(existsSync(wav), false); // file cleaned up
  rmSync(dir, { recursive: true, force: true });
});
