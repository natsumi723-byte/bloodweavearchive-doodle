import assert from "node:assert/strict";
import WebSocket from "ws";

const endpoint = process.argv[2] || "ws://127.0.0.1:5042/api/boards/qa-storage-degradation/socket";
const origin = process.env.INTEGRATION_ORIGIN || "http://127.0.0.1:5043";
const adminSecret = process.env.INTEGRATION_ADMIN_SECRET;
if (!adminSecret) throw new Error("INTEGRATION_ADMIN_SECRET_required");
const inboxes = new WeakMap();

function connect(owner, admin = false) {
  return new Promise((resolve, reject) => {
    const protocols = ["bwa-v2", `owner.${owner}`];
    if (admin) protocols.push(`admin.${adminSecret}`);
    const target = admin
      ? endpoint.replace("/api/boards/", "/api/admin/boards/")
      : endpoint;
    const socket = new WebSocket(target, protocols, { origin });
    const inbox = { messages: [], waiter: null };
    inboxes.set(socket, inbox);
    socket.on("message", (value) => {
      const message = JSON.parse(value.toString());
      if (inbox.waiter) {
        const waiter = inbox.waiter;
        inbox.waiter = null;
        waiter(message);
      } else {
        inbox.messages.push(message);
      }
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket, timeout = 4000) {
  const inbox = inboxes.get(socket);
  if (!inbox) return Promise.reject(new Error("missing_inbox"));
  if (inbox.messages.length > 0) return Promise.resolve(inbox.messages.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inbox.waiter = null;
      reject(new Error("message_timeout"));
    }, timeout);
    inbox.waiter = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
  });
}

async function until(socket, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const message = await next(socket, Math.max(1, deadline - Date.now()));
    if (predicate(message)) return message;
  }
  throw new Error("matching_message_timeout");
}

function commit(id) {
  return {
    type: "stroke.commit",
    mutationId: `mutation_${crypto.randomUUID().replaceAll("-", "")}`,
    id,
    payload: { mutations: [{ tool: 0, type: 1, id }] },
  };
}

const a = await connect("A".repeat(43));
assert.equal((await next(a)).type, "snapshot");
const first = commit(`stroke_${crypto.randomUUID().replaceAll("-", "")}`);
a.send(JSON.stringify(first));
assert.equal((await until(a, (message) => message.mutationId === first.mutationId)).status, "committed");

const b = await connect("B".repeat(43));
assert.equal((await next(b)).items.length, 1);
const overflow = commit(`stroke_${crypto.randomUUID().replaceAll("-", "")}`);
b.send(JSON.stringify(overflow));
assert.equal((await until(b, (message) => message.code === "board_full")).code, "board_full");
assert.equal((await until(a, (message) => message.code === "board_full")).code, "board_full");

a.close();
const reconnect = await connect("A".repeat(43));
assert.equal((await next(reconnect)).type, "snapshot");
assert.equal((await next(reconnect)).code, "read_only_degraded");
const blocked = commit(`stroke_${crypto.randomUUID().replaceAll("-", "")}`);
reconnect.send(JSON.stringify(blocked));
assert.equal((await until(reconnect, (message) => message.mutationId === blocked.mutationId)).code, "read_only_degraded");

const admin = await connect("C".repeat(43), true);
assert.equal((await next(admin)).type, "snapshot");
assert.equal((await next(admin)).code, "read_only_degraded");
const clearMutationId = `mutation_${crypto.randomUUID().replaceAll("-", "")}`;
admin.send(JSON.stringify({ type: "admin.delete_all", mutationId: clearMutationId }));
assert.equal((await until(admin, (message) => message.type === "board.recovered")).type, "board.recovered");
assert.equal((await until(admin, (message) => message.mutationId === clearMutationId)).status, "committed");
assert.equal((await until(reconnect, (message) => message.type === "board.recovered")).type, "board.recovered");

const afterRecovery = commit(`stroke_${crypto.randomUUID().replaceAll("-", "")}`);
reconnect.send(JSON.stringify(afterRecovery));
assert.equal((await until(reconnect, (message) => message.mutationId === afterRecovery.mutationId)).status, "committed");

b.close();
reconnect.close();
admin.close();
console.log(JSON.stringify({
  ok: true,
  boardWideDegradation: true,
  reconnectFailClosed: true,
  writesBlockedWhileDegraded: true,
  adminRecovery: true,
  writesResumeAfterRecovery: true,
}));
