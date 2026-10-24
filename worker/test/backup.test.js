import test from "node:test";
import assert from "node:assert/strict";
import { createBackupBundle, runBackupRotation, validateBackupBundle } from "../src/backup.js";

function snapshot(boardId = "archive") {
  return {
    schema: "bwa-board-snapshot/v1",
    boardId,
    sequence: 3,
    strokes: [
      { id: "stroke_a", payload: { mutations: [{ x: 1 }] }, ownerHash: "a".repeat(64), sequence: 1, createdAt: 1, deletedAt: null },
      { id: "stroke_b", payload: { mutations: [{ x: 2 }] }, ownerHash: "b".repeat(64), sequence: 2, createdAt: 2, deletedAt: 3 },
    ],
  };
}

test("portable backup detects tampering", async () => {
  const bundle = await createBackupBundle(snapshot(), new Date("2026-10-24T19:30:00Z"));
  assert.equal((await validateBackupBundle(JSON.stringify(bundle))).manifest.activeCount, 1);
  bundle.snapshot.sequence = 99;
  await assert.rejects(() => validateBackupBundle(bundle), /backup_digest_mismatch/);
});

test("portable backup rejects duplicate IDs and malformed ownership fields", async () => {
  const malformed = snapshot();
  malformed.strokes[1].id = malformed.strokes[0].id;
  await assert.rejects(() => createBackupBundle(malformed), /invalid_snapshot_item/);
  malformed.strokes[1].id = "stroke_b";
  malformed.strokes[1].ownerHash = "not-a-hash";
  await assert.rejects(() => createBackupBundle(malformed), /invalid_snapshot_item/);
});

test("rotation validates the uploaded bytes before deleting backup 31", async () => {
  const deleted = [];
  const files = Array.from({ length: 30 }, (_, index) => ({
    id: `old-${index}`,
    name: `old-${index}.json`,
    createdTime: new Date(Date.UTC(2026, 9, 23 - index)).toISOString(),
  }));
  const drive = {
    content: new Map(),
    async upload({ name, content }) {
      this.content.set("new", content);
      files.push({ id: "new", name, createdTime: "2026-10-24T19:30:00.000Z" });
      return files.at(-1);
    },
    async download(id) { return this.content.get(id); },
    async list() { return files; },
    async delete(id) { deleted.push(id); },
  };
  const result = await runBackupRotation({ snapshot: snapshot(), drive, folderId: "private-folder", now: new Date("2026-10-24T19:30:00Z") });
  assert.equal(result.retained, 30);
  assert.deepEqual(deleted, ["old-29"]);
});

test("rotation never deletes an old backup when validation fails", async () => {
  const deleted = [];
  const drive = {
    async upload() { return { id: "broken", name: "broken.json" }; },
    async download() { return "{}"; },
    async list() { throw new Error("must_not_list_after_failed_validation"); },
    async delete(id) { deleted.push(id); },
  };
  await assert.rejects(() => runBackupRotation({ snapshot: snapshot(), drive, folderId: "private-folder" }), /invalid_backup_schema/);
  assert.deepEqual(deleted, []);
});
