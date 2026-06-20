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
