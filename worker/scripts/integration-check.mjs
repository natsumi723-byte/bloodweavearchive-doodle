import assert from "node:assert/strict";

const endpoint = process.argv[2] || "ws://127.0.0.1:5042/api/boards/integration-check/socket";
const tokenA = "A".repeat(43);
const tokenB = "B".repeat(43);

function connect(token, admin = null) {
  return new Promise((resolve, reject) => {
    const protocols = ["bwa-v2", `owner.${token}`];
    if (admin) protocols.push(`admin.${admin}`);
    const socket = new WebSocket(endpoint, protocols);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 3000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
}

const a = await connect(tokenA);
const firstSnapshot = await nextMessage(a);
assert.equal(firstSnapshot.type, "snapshot");
const id = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
const firstMutation = {
  type: "stroke.commit",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id,
  payload: { tool: "pencil", color: "#7f293b", points: [[1, 2], [3, 4]] },
};
const firstAckPromise = nextMessage(a);
a.send(JSON.stringify(firstMutation));
const firstAck = await firstAckPromise;
assert.equal(firstAck.type, "mutation.ack");
assert.equal(firstAck.status, "committed");
assert.equal(firstAck.mutationId, firstMutation.mutationId);

const duplicateAckPromise = nextMessage(a);
a.send(JSON.stringify(firstMutation));
const duplicateAck = await duplicateAckPromise;
assert.equal(duplicateAck.mutationId, firstMutation.mutationId);
assert.equal(duplicateAck.sequence, firstAck.sequence);
assert.equal(duplicateAck.duplicate, true);

await new Promise((resolve) => setTimeout(resolve, 100));
const b = await connect(tokenB);
const bSnapshot = await nextMessage(b);
assert.equal(bSnapshot.items.some((item) => item.id === id), true);

b.send(JSON.stringify({ type: "stroke.delete", mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`, id }));
assert.equal((await nextMessage(b)).code, "not_item_owner");

const deletion = nextMessage(b);
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
const admin = await connect("C".repeat(43), "local-admin-bwa-v2-secret-at-least-32-characters");
await new Promise((resolve) => setTimeout(resolve, 100));
const adminDeletion = nextMessage(b);
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
const adminMove = nextMessage(b);
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
