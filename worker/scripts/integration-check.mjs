import assert from "node:assert/strict";
import WebSocket from "ws";

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
  persistedReplay: true,
}));
