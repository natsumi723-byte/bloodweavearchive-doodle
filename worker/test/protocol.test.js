import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBoardId, parseClientMessage, validOwnerToken } from "../src/protocol.js";
import { verifySecret } from "../src/ownership.js";

test("accepts only bounded board identifiers", () => {
  assert.equal(normalizeBoardId("BWA-ARCHIVE-V2"), "bwa-archive-v2");
  assert.equal(normalizeBoardId("../secret"), null);
});

test("requires a high-entropy URL-safe owner token", () => {
  assert.equal(validOwnerToken("a".repeat(32)), true);
  assert.equal(validOwnerToken("short"), false);
});

test("accepts one completed stroke payload", () => {
  const parsed = parseClientMessage(JSON.stringify({
    type: "stroke.commit",
    mutationId: "mutation_1234567890",
    id: "stroke_12345678",
    payload: { tool: "pencil", points: [[1, 2], [3, 4]] },
  }));
  assert.equal(parsed.ok, true);
});

test("accepts one bounded atomic mixed stroke batch", () => {
  const parsed = parseClientMessage(JSON.stringify({
    type: "stroke.batch",
    mutationId: "mutation_batch_1234567890",
    sender: "socket_12345678",
    operations: [
      {
        type: "stroke.commit",
        id: "stroke_12345678",
        payload: { mutations: [{ tool: 7, type: 2, id: "stroke_12345678" }] },
      },
      { type: "stroke.delete", id: "stroke_87654321" },
    ],
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.message.operations.map((operation) => operation.type), [
    "stroke.commit",
    "stroke.delete",
  ]);
});

test("rejects malformed or empty atomic stroke batches", () => {
  const base = {
    type: "stroke.batch",
    mutationId: "mutation_batch_1234567890",
  };
  assert.equal(
    parseClientMessage(JSON.stringify({ ...base, operations: [] })).code,
    "invalid_batch",
  );
  assert.equal(
    parseClientMessage(JSON.stringify({
      ...base,
      operations: [{ type: "stroke.unknown", id: "stroke_12345678" }],
    })).code,
    "invalid_batch_operation",
  );
});

test("rejects malformed deletes and oversized payloads", () => {
  assert.equal(parseClientMessage('{"type":"stroke.delete","mutationId":"mutation_1234567890","id":"x"}').ok, false);
  const huge = JSON.stringify({ type: "stroke.commit", mutationId: "mutation_1234567890", id: "stroke_12345678", payload: { value: "x".repeat(262145) } });
  assert.equal(parseClientMessage(huge).code, "payload_too_large");
});

test("requires stable mutation ids for durable writes", () => {
  const withoutId = parseClientMessage(JSON.stringify({
    type: "stroke.commit",
    id: "stroke_12345678",
    payload: { tool: "pencil" },
  }));
  assert.equal(withoutId.code, "invalid_mutation_id");
  assert.equal(parseClientMessage(JSON.stringify({
    type: "admin.delete_all",
    mutationId: "mutation_1234567890",
  })).ok, true);
});

test("admin secret comparison accepts only an exact value", async () => {
  assert.equal(await verifySecret("correct-secret", "correct-secret"), true);
  assert.equal(await verifySecret("wrong-secret", "correct-secret"), false);
});
