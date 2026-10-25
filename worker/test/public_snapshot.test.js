import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicSnapshot,
  publicSnapshotKey,
  readPublicSnapshot,
  writePublicSnapshot,
} from "../src/public_snapshot.js";

function sourceSnapshot() {
  return {
    schema: "bwa-board-snapshot/v1",
    boardId: "bwa-unfinished-archive",
    sequence: 8,
    strokes: [
      {
        id: "stroke_active_1",
        payload: { mutations: [{ type: 1, tool: 0 }] },
        ownerHash: "a".repeat(64),
        sequence: 7,
        createdAt: 1,
        deletedAt: null,
      },
      {
        id: "stroke_deleted_1",
        payload: { mutations: [{ type: 1, tool: 0 }] },
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

