import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicSnapshot,
  nextPublicSnapshotAlarm,
  publicSnapshotKey,
  readPublicSnapshot,
  writePublicSnapshot,
} from "../src/public_snapshot.js";

test("snapshot alarms debounce until quiet without crossing the hard deadline", () => {
  const dirtySince = 1_000_000;
  const quietMs = 30_000;
  const maxMs = 600_000;
  const first = nextPublicSnapshotAlarm({
    currentAlarm: null,
    dirtySince,
    now: dirtySince,
    quietMs,
    maxMs,
  });
  assert.equal(first, dirtySince + quietMs);

  const belowGranularity = nextPublicSnapshotAlarm({
    currentAlarm: first,
    dirtySince,
    now: dirtySince + 5_000,
    quietMs,
    maxMs,
  });
  assert.equal(belowGranularity, first);

  const afterMoreActivity = nextPublicSnapshotAlarm({
    currentAlarm: first,
    dirtySince,
    now: dirtySince + 15_000,
    quietMs,
    maxMs,
  });
  assert.equal(afterMoreActivity, dirtySince + 45_000);

  const capped = nextPublicSnapshotAlarm({
    currentAlarm: dirtySince + 590_000,
    dirtySince,
    now: dirtySince + 590_000,
    quietMs,
    maxMs,
  });
  assert.equal(capped, dirtySince + maxMs);
});

function sourceSnapshot() {
  return {
    schema: "bwa-board-snapshot/v1",
    boardId: "bwa-unfinished-archive",
    sequence: 8,
    strokes: [
      {
        id: "stroke_active_1",
        payload: {
          mutations: [
            {
              type: 1,
              tool: 1,
              id: "stroke_active_1",
              color: "#8f2949",
              size: 4,
              opacity: 1,
            },
          ],
        },
        ownerHash: "a".repeat(64),
        sequence: 7,
        createdAt: 1,
        deletedAt: null,
      },
      {
        id: "stroke_deleted_1",
        payload: {
          mutations: [
            {
              type: 1,
              tool: 1,
              id: "stroke_deleted_1",
              color: "#8f2949",
              size: 4,
              opacity: 1,
            },
          ],
        },
        ownerHash: "b".repeat(64),
        sequence: 8,
        createdAt: 2,
        deletedAt: 3,
      },
    ],
  };
}

test("public snapshots omit ownership and tombstones", () => {
  const value = createPublicSnapshot(
    sourceSnapshot(),
    new Date("2026-10-25T00:00:00.000Z"),
  );
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].id, "stroke_active_1");
  assert.equal("ownerHash" in value.items[0], false);
  assert.equal(JSON.stringify(value).includes("stroke_deleted_1"), false);
});

test("public snapshot writes project mutations before persistence", async () => {
  const stored = [];
  const snapshot = sourceSnapshot();
  snapshot.strokes[0].payload.mutations[0].ownerHash = "private";
  snapshot.strokes[0].payload.mutations[0].secret = "private";
  await writePublicSnapshot(
    { async put(key, body) { stored.push({ key, body }); } },
    snapshot,
    new Date("2026-10-25T00:00:00.000Z"),
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].body.includes("private"), false);
  assert.deepEqual(
    JSON.parse(stored[0].body).items[0].payload.mutations[0],
    {
      type: 1,
      tool: 1,
      id: "stroke_active_1",
      color: "#8f2949",
      size: 4,
      opacity: 1,
    },
  );
});

test("invalid writes cannot replace the last good public snapshot", async () => {
  const objects = new Map();
  let writes = 0;
  const bucket = {
    async put(key, body) {
      writes += 1;
      objects.set(key, body);
    },
  };
  const good = sourceSnapshot();
  await writePublicSnapshot(
    bucket,
    good,
    new Date("2026-10-25T00:00:00.000Z"),
  );
  const key = publicSnapshotKey(good.boardId);
  const lastGood = objects.get(key);
  const invalid = sourceSnapshot();
  invalid.sequence = 9;
  invalid.strokes[0].payload.mutations = [
    { tool: 99, type: 99, secret: "SENSITIVE_SENTINEL" },
  ];
  await assert.rejects(
    writePublicSnapshot(
      bucket,
      invalid,
      new Date("2026-10-25T00:01:00.000Z"),
    ),
    /invalid_public_snapshot/,
  );
  assert.equal(writes, 1);
  assert.equal(objects.get(key), lastGood);
  assert.equal(objects.get(key).includes("SENSITIVE_SENTINEL"), false);
});

test("R2 round trip uses a stable board key", async () => {
  const objects = new Map();
  const bucket = {
    async put(key, body, options) {
      objects.set(key, { body, options });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        async json() {
          return JSON.parse(stored.body);
        },
        writeHttpMetadata(headers) {
          headers.set("Content-Type", stored.options.httpMetadata.contentType);
          headers.set("Cache-Control", stored.options.httpMetadata.cacheControl);
        },
        httpEtag: '"fixture-etag"',
      };
    },
  };
  const snapshot = sourceSnapshot();
  await writePublicSnapshot(
    bucket,
    snapshot,
    new Date("2026-10-25T00:00:00.000Z"),
  );
  assert.equal(
    publicSnapshotKey(snapshot.boardId),
    "boards/bwa-unfinished-archive/latest.json",
  );
  const found = await readPublicSnapshot(bucket, snapshot.boardId);
  assert.equal(found.value.sequence, 8);
  assert.equal(found.value.items.length, 1);
});

test("public snapshot reads project only allowlisted fields", async () => {
  const polluted = {
    schema: "bwa-public-board-snapshot/v1",
    boardId: "bwa-unfinished-archive",
    sequence: 8,
    createdAt: "2026-10-25T00:00:00.000Z",
    ownerHash: "private",
    mutationReceipts: ["private"],
    adminIdentity: "private",
    secret: "private",
    items: [
      {
        id: "stroke_active_1",
        payload: {
          mutations: [
            {
              type: 1,
              tool: 1,
              id: "stroke_active_1",
              color: "#8f2949",
              size: 4,
              opacity: 1,
              owner_hash: "private",
              adminToken: "private",
              password: "private",
              deleted_at: 1,
            },
          ],
        },
        sequence: 7,
        ownerHash: "private",
        deletedAt: null,
      },
    ],
  };
  const object = {
    async json() {
      return polluted;
    },
  };
  const found = await readPublicSnapshot(
    { async get() { return object; } },
    "bwa-unfinished-archive",
  );
  assert.deepEqual(Object.keys(found.value), [
    "schema",
    "boardId",
    "sequence",
    "createdAt",
    "items",
  ]);
  assert.deepEqual(Object.keys(found.value.items[0]), [
    "id",
    "payload",
    "sequence",
  ]);
  assert.equal(JSON.stringify(found.value).includes("private"), false);
  assert.deepEqual(found.value.items[0].payload.mutations[0], {
    type: 1,
    tool: 1,
    id: "stroke_active_1",
    color: "#8f2949",
    size: 4,
    opacity: 1,
  });
});

test("public snapshot reads reject mismatches, malformed values and prohibited payload metadata", async () => {
  const base = {
    schema: "bwa-public-board-snapshot/v1",
    boardId: "bwa-unfinished-archive",
    sequence: 8,
    createdAt: "2026-10-25T00:00:00.000Z",
    items: [
      {
        id: "stroke_active_1",
        payload: {
          mutations: [
            {
              type: 1,
              tool: 1,
              id: "stroke_active_1",
              color: "#8f2949",
              size: 4,
              opacity: 1,
            },
          ],
        },
        sequence: 7,
      },
    ],
  };
  const invalid = [
    { ...base, boardId: "different-board" },
    { ...base, createdAt: "not-a-date" },
    { ...base, items: [{ ...base.items[0], payload: {} }] },
    { ...base, items: [{ ...base.items[0], payload: { mutations: [{}] } }] },
    {
      ...base,
      items: [{ ...base.items[0], payload: { mutations: [{ type: 99, tool: 1 }] } }],
    },
  ];
  for (const value of invalid) {
    await assert.rejects(
      readPublicSnapshot(
        { async get() { return { async json() { return value; } }; } },
        "bwa-unfinished-archive",
      ),
      /invalid_public_snapshot/,
    );
  }
  await assert.rejects(
    readPublicSnapshot(
      { async get() { throw new Error("r2 unavailable"); } },
      "bwa-unfinished-archive",
    ),
    /r2 unavailable/,
  );
});

