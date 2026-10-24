import assert from "node:assert/strict";
import WebSocket from "ws";

const boardId = `qa-lost-ack-${crypto.randomUUID().replaceAll("-", "")}`;
const endpoint =
  process.argv[2] ||
  `ws://127.0.0.1:5042/api/boards/${boardId}/socket`;
const origin = process.env.INTEGRATION_ORIGIN || "http://127.0.0.1:5043";
const owner = "L".repeat(43);
const strokeId = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
const frame = {
  type: "stroke.commit",
  mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
  id: strokeId,
  payload: { mutations: [{ tool: 0, type: 1, id: strokeId }] },
};

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, ["bwa-v2", `owner.${owner}`], { origin });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket, event = "message", timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event}_timeout`)), timeout);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function nextMessageType(socket, type, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const message = JSON.parse(
      (await next(socket, "message", deadline - Date.now())).toString(),
    );
    if (message.type === type) return message;
  }
  throw new Error(`${type}_timeout`);
}

const first = await connect();
await nextMessageType(first, "snapshot");
const closed = next(first, "close");
first.send(JSON.stringify(frame));
await closed;

const second = await connect();
const snapshot = await nextMessageType(second, "snapshot");
assert.equal(snapshot.items.filter((item) => item.id === strokeId).length, 1);
second.send(JSON.stringify(frame));
const ack = await nextMessageType(second, "mutation.ack");
assert.equal(ack.type, "mutation.ack");
assert.equal(ack.mutationId, frame.mutationId);
assert.equal(ack.duplicate, true);
second.close();

console.log(JSON.stringify({
  ok: true,
  droppedAckObserved: true,
  reconnectObserved: true,
  duplicateFreeConvergence: true,
  strokeId,
  mutationId: frame.mutationId,
}));
