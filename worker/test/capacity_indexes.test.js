import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/index.js"), "utf8");

function createBoardDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE strokes (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      owner_hash TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX strokes_sequence ON strokes(sequence);
    CREATE INDEX strokes_active_sequence ON strokes(sequence) WHERE deleted_at IS NULL;
    CREATE INDEX strokes_tombstone_age ON strokes(deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE TABLE mutation_log (
      mutation_id TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT,
      response TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX mutation_log_created_at ON mutation_log(created_at);
  `);
  return database;
}

test("capacity indexes are idempotent in the Durable Object schema", () => {
  for (const statement of [
    "CREATE INDEX IF NOT EXISTS strokes_active_sequence",
    "CREATE INDEX IF NOT EXISTS strokes_tombstone_age",
    "CREATE INDEX IF NOT EXISTS mutation_log_created_at",
  ]) {
    assert.match(source, new RegExp(statement));
  }
});

test("tombstone-heavy plans use partial/time indexes and preserve semantics", () => {
  const database = createBoardDatabase();
  const insertStroke = database.prepare(
    "INSERT INTO strokes VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertMutation = database.prepare(
    "INSERT INTO mutation_log VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = 2_000_000_000_000;
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  database.exec("BEGIN");
  for (let index = 0; index < 10_000; index += 1) {
    insertStroke.run(
      `dead-${index}`,
      JSON.stringify({ mutations: [{ index }] }),
      "owner",
      index + 1,
      now - index,
      index < 8_000 ? cutoff - index - 1 : cutoff + index + 1,
    );
    insertMutation.run(
      `mutation-${index}`,
      "owner",
      "stroke.delete",
      `dead-${index}`,
      "{}",
      index < 8_000 ? cutoff - index - 1 : cutoff + index + 1,
    );
  }
  for (let index = 0; index < 20; index += 1) {
    insertStroke.run(
      `active-${index}`,
      JSON.stringify({ mutations: [{ index }] }),
      "owner",
      20_000 + index,
      now + index,
      null,
    );
  }
  database.exec("COMMIT");

  const plan = (sql, ...params) =>
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
      .map((row) => String(row.detail))
      .join(" | ");
  const activePlan = plan(
    "SELECT id, payload, sequence FROM strokes WHERE deleted_at IS NULL ORDER BY sequence",
  );
  const tombstonePlan = plan(
    "SELECT COUNT(*) FROM strokes WHERE deleted_at IS NOT NULL AND deleted_at < ?",
    cutoff,
  );
  const mutationPlan = plan(
    "SELECT COUNT(*) FROM mutation_log WHERE created_at < ?",
    cutoff,
  );
  assert.match(activePlan, /strokes_active_sequence/);
  assert.match(tombstonePlan, /strokes_tombstone_age/);
  assert.match(mutationPlan, /mutation_log_created_at/);

  const active = database
    .prepare(
      "SELECT id, payload, sequence FROM strokes WHERE deleted_at IS NULL ORDER BY sequence",
    )
    .all();
  assert.equal(active.length, 20);
  assert.deepEqual(
    active.map((row) => row.sequence),
    Array.from({ length: 20 }, (_, index) => 20_000 + index),
  );

  const before = {
    strokes: database.prepare("SELECT COUNT(*) AS count FROM strokes").get().count,
    active: active.length,
    mutations: database.prepare("SELECT COUNT(*) AS count FROM mutation_log").get().count,
  };
  database
    .prepare(
      "DELETE FROM strokes WHERE deleted_at IS NOT NULL AND deleted_at < ?",
    )
    .run(cutoff);
  database
    .prepare("DELETE FROM mutation_log WHERE created_at < ?")
    .run(cutoff);
  const after = {
    strokes: database.prepare("SELECT COUNT(*) AS count FROM strokes").get().count,
    active: database
      .prepare("SELECT COUNT(*) AS count FROM strokes WHERE deleted_at IS NULL")
      .get().count,
    mutations: database.prepare("SELECT COUNT(*) AS count FROM mutation_log").get().count,
  };
  assert.deepEqual(before, { strokes: 10_020, active: 20, mutations: 10_000 });
  assert.deepEqual(after, { strokes: 2_020, active: 20, mutations: 2_000 });

  // Local rows-read proxy: active snapshot access is bounded by live rows,
  // rather than the complete active+tombstone table population.
  assert.deepEqual({ fullScanProxy: before.strokes, indexedProxy: active.length }, {
    fullScanProxy: 10_020,
    indexedProxy: 20,
  });

  const snapshotRows = database
    .prepare(
      "SELECT id, payload, owner_hash, sequence, created_at, deleted_at FROM strokes ORDER BY sequence, id",
    )
    .all();
  const restored = createBoardDatabase();
  const restore = restored.prepare("INSERT INTO strokes VALUES (?, ?, ?, ?, ?, ?)");
  restored.exec("BEGIN");
  for (const row of snapshotRows) {
    restore.run(
      row.id,
      row.payload,
      row.owner_hash,
      row.sequence,
      row.created_at,
      row.deleted_at,
    );
  }
  restored.exec("COMMIT");
  assert.deepEqual(
    restored
      .prepare(
        "SELECT id, payload, owner_hash, sequence, created_at, deleted_at FROM strokes ORDER BY sequence, id",
      )
      .all(),
    snapshotRows,
  );
});
