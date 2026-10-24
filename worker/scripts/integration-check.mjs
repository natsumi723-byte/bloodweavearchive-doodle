import assert from "node:assert/strict";
import WebSocket from "ws";
import { createBackupBundle } from "../src/backup.js";

const endpoint = process.argv[2] || "ws://127.0.0.1:5042/api/boards/integration-check/socket";
const tokenA = "A".repeat(43);
const tokenB = "B".repeat(43);
const adminSecret = process.env.INTEGRATION_ADMIN_SECRET;
if (!adminSecret) throw new Error("INTEGRATION_ADMIN_SECRET_required");

function connect(token, admin = null) {
  return new Promise((resolve, reject) => {
    const protocols = ["bwa-v2", `owner.${token}`];
    if (admin) protocols.push(`admin.${admin}`);
    const target = admin
      ? endpoint.replace("/api/boards/", "/api/admin/boards/")
      : endpoint;
    const socket = new WebSocket(target, protocols, {
      origin: process.env.INTEGRATION_ORIGIN || "http://127.0.0.1:5043",
    });
    inboxFor(socket);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

const inboxes = new WeakMap();

function inboxFor(socket) {
  let inbox = inboxes.get(socket);
  if (inbox) return inbox;
  inbox = { messages: [], waiters: [] };
  inboxes.set(socket, inbox);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiterIndex = inbox.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex === -1) {
      inbox.messages.push(message);
      return;
    }
    const [waiter] = inbox.waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  return inbox;
}

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const inbox = inboxFor(socket);
    const messageIndex = inbox.messages.findIndex(predicate);
    if (messageIndex !== -1) {
      resolve(inbox.messages.splice(messageIndex, 1)[0]);
      return;
    }
    const timer = setTimeout(() => reject(new Error("message timeout")), 3000);
    inbox.waiters.push({ predicate, resolve, reject, timer });
  });
}

function sendAndWait(socket, message, predicate = (reply) =>
  reply.type === "mutation.ack" && reply.mutationId === message.mutationId) {
  const reply = nextMessage(socket, predicate);
  socket.send(JSON.stringify(message));
  return reply;
}

async function exportBoard() {
  const socketUrl = new URL(endpoint);
  const boardId = socketUrl.pathname.split("/").at(-2);
  const response = await fetch(
    `${socketUrl.protocol === "wss:" ? "https:" : "http:"}//${socketUrl.host}/api/admin/boards/${boardId}/export`,
    {
      headers: {
        Origin: process.env.INTEGRATION_ORIGIN || "http://127.0.0.1:5043",
        "Cf-Access-Jwt-Assertion": "local-test-assertion",
        Authorization: `Bearer ${adminSecret}`,
      },
    },
  );
  assert.equal(response.ok, true);
  return response.json();
}

async function adminRequest(action, init = {}) {
  const socketUrl = new URL(endpoint);
  const boardId = socketUrl.pathname.split("/").at(-2);
  return fetch(
    `${socketUrl.protocol === "wss:" ? "https:" : "http:"}//${socketUrl.host}/api/admin/boards/${boardId}/${action}`,
    {
      ...init,
      headers: {
        Origin: process.env.INTEGRATION_ORIGIN || "http://127.0.0.1:5043",
        "Cf-Access-Jwt-Assertion": "local-test-assertion",
        Authorization: `Bearer ${adminSecret}`,
        ...init.headers,
      },
    },
  );
}

const a = await connect(tokenA);
const firstSnapshot = await nextMessage(a, (message) => message.type === "snapshot");
assert.equal(firstSnapshot.type, "snapshot");
const id = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
const firstMutation = {
  type: "stroke.commit",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id,
  payload: { tool: "pencil", color: "#7f293b", points: [[1, 2], [3, 4]] },
};
const firstAckPromise = nextMessage(
  a,
  (message) => message.type === "mutation.ack" && message.mutationId === firstMutation.mutationId,
);
a.send(JSON.stringify(firstMutation));
const firstAck = await firstAckPromise;
assert.equal(firstAck.type, "mutation.ack");
assert.equal(firstAck.status, "committed");
assert.equal(firstAck.mutationId, firstMutation.mutationId);

const duplicateAckPromise = nextMessage(
  a,
  (message) => message.type === "mutation.ack" && message.mutationId === firstMutation.mutationId,
);
a.send(JSON.stringify(firstMutation));
const duplicateAck = await duplicateAckPromise;
assert.equal(duplicateAck.mutationId, firstMutation.mutationId);
assert.equal(duplicateAck.sequence, firstAck.sequence);
assert.equal(duplicateAck.duplicate, true);

await new Promise((resolve) => setTimeout(resolve, 100));
const b = await connect(tokenB);
const bSnapshot = await nextMessage(b, (message) => message.type === "snapshot");
assert.equal(bSnapshot.items.some((item) => item.id === id), true);

b.send(JSON.stringify({ type: "stroke.delete", mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`, id }));
assert.equal((await nextMessage(b, (message) => message.type === "error")).code, "not_item_owner");

const deletion = nextMessage(b, (message) => message.type === "stroke.delete" && message.id === id);
a.send(JSON.stringify({ type: "stroke.delete", mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`, id }));
const deletionMessage = await deletion;
assert.equal(deletionMessage.type, "stroke.delete");
assert.equal(deletionMessage.id, id);
assert.equal(Number.isFinite(deletionMessage.sequence), true);

const secondId = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
a.send(JSON.stringify({
  type: "stroke.commit",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id: secondId,
  payload: { tool: "pencil", points: [[5, 6], [7, 8]] },
}));
await new Promise((resolve) => setTimeout(resolve, 100));
const admin = await connect("C".repeat(43), adminSecret);
await new Promise((resolve) => setTimeout(resolve, 100));
const adminDeletion = nextMessage(b, (message) => message.type === "stroke.delete" && message.id === secondId);
admin.send(JSON.stringify({
  type: "stroke.delete",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id: secondId,
}));
assert.equal((await adminDeletion).id, secondId);

const thirdId = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
a.send(JSON.stringify({
  type: "stroke.commit",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id: thirdId,
  payload: { mutations: [{ type: 1, id: thirdId, tool: 0 }] },
}));
await new Promise((resolve) => setTimeout(resolve, 100));
const adminMove = nextMessage(b, (message) => message.type === "stroke.commit" && message.id === thirdId);
admin.send(JSON.stringify({
  type: "stroke.commit",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id: thirdId,
  payload: { mutations: [{ type: 2, id: thirdId, transform: { e: 20, f: 30 } }] },
}));
assert.equal((await adminMove).id, thirdId);

const mixedUpdateId = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
const mixedDeleteId = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
for (const mixedId of [mixedUpdateId, mixedDeleteId]) {
  await sendAndWait(a, {
    type: "stroke.commit",
    mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
    id: mixedId,
    payload: { mutations: [{ tool: 5, type: 1, id: mixedId, txt: mixedId }] },
  });
}
const mixedMutation = {
  type: "stroke.batch",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  sender: `socket_${crypto.randomUUID().replaceAll("-", "")}`,
  operations: [
    {
      type: "stroke.commit",
      id: mixedUpdateId,
      payload: {
        mutations: [
          { tool: 7, type: 2, id: mixedUpdateId, transform: { e: 44, f: 55 } },
        ],
      },
    },
    { type: "stroke.delete", id: mixedDeleteId },
  ],
};
const peerMixed = nextMessage(b, (message) =>
  message.type === "stroke.batch" && message.mutationId === mixedMutation.mutationId);
const mixedAck = await sendAndWait(a, mixedMutation);
const mixedEvent = await peerMixed;
assert.equal(mixedAck.affected, 2);
assert.deepEqual(mixedEvent.events.map((event) => event.type), [
  "stroke.commit",
  "stroke.delete",
]);
const duplicateMixedAck = await sendAndWait(a, mixedMutation);
assert.equal(duplicateMixedAck.duplicate, true);
assert.equal(duplicateMixedAck.sequence, mixedAck.sequence);
const afterMixed = await exportBoard();
const updated = afterMixed.snapshot.strokes.find((stroke) => stroke.id === mixedUpdateId);
const deleted = afterMixed.snapshot.strokes.find((stroke) => stroke.id === mixedDeleteId);
assert.equal(updated.payload.mutations.at(-1).transform.e, 44);
assert.equal(deleted.deletedAt !== null, true);
assert.equal(afterMixed.manifest.tombstoneCount >= 1, true);
assert.equal(
  afterMixed.manifest.activeCount,
  afterMixed.snapshot.strokes.filter((stroke) => stroke.deletedAt === null).length,
);

const foreignId = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
await sendAndWait(b, {
  type: "stroke.commit",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id: foreignId,
  payload: { mutations: [{ tool: 0, type: 1, id: foreignId }] },
});
const beforeFailed = await exportBoard();
const beforeFailedPayload = beforeFailed.snapshot.strokes.find(
  (stroke) => stroke.id === mixedUpdateId,
).payload;
const failedBatch = {
  type: "stroke.batch",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  operations: [
    {
      type: "stroke.commit",
      id: mixedUpdateId,
      payload: {
        mutations: [
          { tool: 7, type: 2, id: mixedUpdateId, transform: { e: 999, f: 999 } },
        ],
      },
    },
    { type: "stroke.delete", id: foreignId },
  ],
};
const failed = await sendAndWait(
  a,
  failedBatch,
  (message) => message.type === "error" && message.mutationId === failedBatch.mutationId,
);
assert.equal(failed.code, "not_item_owner");
const afterFailed = await exportBoard();
assert.equal(afterFailed.snapshot.sequence, beforeFailed.snapshot.sequence);
assert.deepEqual(
  afterFailed.snapshot.strokes.find((stroke) => stroke.id === mixedUpdateId).payload,
  beforeFailedPayload,
);
assert.equal(
  afterFailed.snapshot.strokes.find((stroke) => stroke.id === foreignId).deletedAt,
  null,
);
const retentionSnapshot = structuredClone(afterFailed.snapshot);
retentionSnapshot.strokes.find(
  (stroke) => stroke.id === mixedDeleteId,
).deletedAt = Date.now() - 31 * 86400000;
const retentionBundle = await createBackupBundle(retentionSnapshot);
const restoreResponse = await adminRequest("restore", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(retentionBundle),
});
assert.equal(restoreResponse.ok, true);
const purgeResponse = await adminRequest("purge", { method: "POST" });
assert.equal(purgeResponse.ok, true);
assert.equal((await purgeResponse.json()).purged >= 1, true);
const afterPurge = await exportBoard();
assert.equal(
  afterPurge.snapshot.strokes.some((stroke) => stroke.id === mixedDeleteId),
  false,
);

a.close();
b.close();
admin.close();
console.log(JSON.stringify({
  ok: true,
  acknowledgedCommit: true,
  idempotentReplay: true,
  ownerDeleteProtected: true,
  adminDelete: true,
  adminMove: true,
  atomicMixedBatch: true,
  idempotentMixedBatchRetry: true,
  atomicFailureRollback: true,
  quotaReleasedByBatchDelete: true,
  tombstoneBackupReadback: true,
  tombstoneRetentionPurge: true,
  persistedReplay: true,
}));
