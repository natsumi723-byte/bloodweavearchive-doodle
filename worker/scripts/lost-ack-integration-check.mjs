import assert from "node:assert/strict";
import WebSocket from "ws";

const endpoint = process.argv[2] || "ws://127.0.0.1:5042/api/boards/qa-lost-ack-runtime/socket";
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

const first = await connect();
JSON.parse((await next(first)).toString());
const closed = next(first, "close");
first.send(JSON.stringify(frame));
await closed;

const second = await connect();
const snapshot = JSON.parse((await next(second)).toString());
assert.equal(snapshot.items.filter((item) => item.id === strokeId).length, 1);
const ackPromise = next(second);
second.send(JSON.stringify(frame));
const ack = JSON.parse((await ackPromise).toString());
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
