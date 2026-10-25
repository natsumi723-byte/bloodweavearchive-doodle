import assert from "node:assert/strict";
import test from "node:test";
import { runScheduledBackups, scheduleBackups } from "../src/scheduled.js";

function fixture(failingBoard = null) {
  const calls = [];
  const stubs = new Map();
  const env = {
    BACKUP_BOARD_IDS: "board-one, board-two",
    GOOGLE_DRIVE_FOLDER_ID: "private-folder",
    PUBLIC_SNAPSHOTS: { kind: "mock-r2" },
    BOARDS: {
      idFromName: (name) => name,
      get(name) {
        if (!stubs.has(name)) {
          stubs.set(name, {
            async purgeTombstones(time, days) {
              calls.push(["purge", name, time, days]);
            },
            async exportSnapshot(boardId) {
              calls.push(["export", name]);
              if (name === failingBoard) throw new Error(`failed:${name}`);
              return { schema: "bwa-board-snapshot/v1", boardId, sequence: 0, strokes: [] };
            },
          });
        }
        return stubs.get(name);
      },
    },
  };
  return { calls, env };
}

test("scheduled orchestration purges, exports, dispatches and preserves retention", async () => {
  const { calls, env } = fixture();
  const rotations = [];
  const publications = [];
  const scheduledTime = Date.UTC(2026, 9, 24, 19, 30);
  const result = await runScheduledBackups(
    { scheduledTime },
    env,
    {
      createDrive: () => ({ kind: "mock-drive" }),
      rotate: async (options) => {
        rotations.push(options);
        return { boardId: options.snapshot.boardId };
      },
      publish: async (bucket, snapshot, now) => {
        publications.push({ bucket, snapshot, now });
      },
    },
  );
  assert.deepEqual(result, [{ boardId: "board-one" }, { boardId: "board-two" }]);
  assert.deepEqual(calls, [
    ["purge", "board-one", scheduledTime, 30],
    ["purge", "board-two", scheduledTime, 30],
    ["export", "board-one"],
    ["export", "board-two"],
  ]);
  assert.equal(rotations.length, 2);
  assert.equal(rotations.every((entry) => entry.retention === 30), true);
  assert.equal(rotations.every((entry) => entry.folderId === "private-folder"), true);
  assert.equal(rotations.every((entry) => entry.now.getTime() === scheduledTime), true);
  assert.equal(publications.length, 2);
  assert.equal(
    publications.every((entry) => entry.bucket === env.PUBLIC_SNAPSHOTS),
    true,
  );
  assert.equal(
    publications.every((entry) => entry.now.getTime() === scheduledTime),
    true,
  );
});

test("scheduled handler registers the complete orchestration with waitUntil", async () => {
  const { env } = fixture();
  let waited = null;
  const completion = scheduleBackups(
    { scheduledTime: 1000 },
    env,
    { waitUntil(promise) { waited = promise; } },
    {
      createDrive: () => ({}),
      rotate: async ({ snapshot }) => ({ boardId: snapshot.boardId }),
      publish: async () => {},
    },
  );
  assert.equal(waited, completion);
  assert.deepEqual(await waited, [{ boardId: "board-one" }, { boardId: "board-two" }]);
});

test("scheduled orchestration waits for every board before surfacing partial failure", async () => {
  const { calls, env } = fixture("board-one");
  const rotations = [];
  await assert.rejects(
    runScheduledBackups(
      { scheduledTime: 1000 },
      env,
      {
        createDrive: () => ({}),
        rotate: async (options) => {
          rotations.push(options.snapshot.boardId);
          return { ok: true };
        },
        publish: async () => {},
      },
    ),
    /backup_partial_failure:1\/2/,
  );
  assert.equal(calls.some((entry) => entry[0] === "export" && entry[1] === "board-two"), true);
  assert.deepEqual(rotations, ["board-two"]);
});
