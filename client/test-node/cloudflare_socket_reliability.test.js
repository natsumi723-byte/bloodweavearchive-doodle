const assert = require("node:assert/strict");
const test = require("node:test");

test("Cloudflare adapter resolves a durable batch only after its ACK", async () => {
  const previousWebSocket = global.WebSocket;
  global.WebSocket = /** @type {any} */ ({ OPEN: 1 });
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    const socket = new CloudflareSocket(
      "https://example.invalid",
      "test-board",
    );
    /** @type {any[]} */
    const sent = [];
    /** @type {any[]} */
    const accepted = [];
    socket.ws = /** @type {any} */ ({
      readyState: 1,
      send(/** @type {string} */ value) {
        sent.push(JSON.parse(value));
      },
    });
    socket.on("mutation_accepted", (/** @type {any} */ payload) =>
      accepted.push(payload),
    );

    socket.emit("broadcast", {
      tool: 0,
      type: 1,
      id: "stroke_12345678",
      clientMutationId: "cm-1234567890123456",
    });
    socket.flushItem("stroke_12345678");

    assert.equal(sent.length, 1);
    assert.equal(accepted.length, 0);
    assert.match(sent[0].mutationId, /^mutation_[A-Za-z0-9_-]{16,}$/);

    socket.receive({
      type: "mutation.ack",
      mutationId: sent[0].mutationId,
      sequence: 7,
      status: "committed",
    });
    assert.deepEqual(accepted[0].clientMutationIds, ["cm-1234567890123456"]);
    assert.equal(socket.inflight.size, 0);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare adapter requests retry and exposes read-only storage failure", async () => {
  const { CloudflareSocket } = await import(
    "../client-data/js/cloudflare_socket_adapter.js"
  );
  const socket = new CloudflareSocket("https://example.invalid", "test-board");
  let retries = 0;
  /** @type {any[]} */
  const states = [];
  socket.on("mutation_retry", () => {
    retries += 1;
  });
  socket.on("boardstate", (/** @type {any} */ state) => states.push(state));
  socket.pending.set("stroke_12345678", [
    { clientMutationId: "cm-1234567890123456" },
  ]);

  socket.dispatch("mutation_retry");
  socket.receive({
    type: "error",
    code: "storage_failure",
    mutationId: "mutation_missing_1234",
  });

  assert.equal(retries, 1);
  assert.equal(states[states.length - 1].canWrite, false);
  assert.equal(states[states.length - 1].canEdit, false);
});

test("Cloudflare adapter reuses the mutation id after a lost ACK and reconnect", async () => {
  const previousWebSocket = global.WebSocket;
  global.WebSocket = /** @type {any} */ ({ OPEN: 1 });
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    const mutation = {
      tool: 0,
      type: 1,
      id: "stroke_lost_ack",
      clientMutationId: "cm-lost-ack-123456789",
    };
    /** @type {any[]} */
    const firstFrames = [];
    const first = new CloudflareSocket("https://example.invalid", "test-board");
    first.ws = /** @type {any} */ ({
      readyState: 1,
      send(/** @type {string} */ value) {
        firstFrames.push(JSON.parse(value));
      },
    });
    first.emit("broadcast", mutation);
    first.flushItem(mutation.id);

    /** @type {any[]} */
    const retryFrames = [];
    const reconnected = new CloudflareSocket(
      "https://example.invalid",
      "test-board",
    );
    reconnected.ws = /** @type {any} */ ({
      readyState: 1,
      send(/** @type {string} */ value) {
        retryFrames.push(JSON.parse(value));
      },
    });
    reconnected.emit("broadcast", mutation);
    reconnected.flushItem(mutation.id);

    assert.equal(retryFrames.length, 1);
    assert.equal(retryFrames[0].mutationId, firstFrames[0].mutationId);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare adapter uses a distinct Access-protected route for admins", async () => {
  const previousWebSocket = global.WebSocket;
  const previousLocation = global.location;
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousSessionStorage = global.sessionStorage;
  const previousLocalStorage = global.localStorage;
  /** @type {any[]} */
  const opened = [];
  global.location = /** @type {any} */ ({ pathname: "/admin/archive" });
  global.window = /** @type {any} */ ({
    prompt: () => "admin-secret",
    addEventListener() {},
  });
  global.document = /** @type {any} */ ({
    addEventListener() {},
    visibilityState: "visible",
  });
  global.sessionStorage = /** @type {any} */ ({ removeItem() {} });
  global.localStorage = /** @type {any} */ ({
    getItem: () => "A".repeat(43),
    setItem() {},
  });
  global.WebSocket = /** @type {any} */ (
    class {
      static OPEN = 1;
      constructor(
        /** @type {string} */ url,
        /** @type {string[]} */ protocols,
      ) {
        opened.push({ url, protocols });
      }
      addEventListener() {}
    }
  );
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    new CloudflareSocket("https://worker.invalid", "archive").connect();
    assert.equal(
      opened[0].url,
      "https://worker.invalid/api/admin/boards/archive/socket",
    );
    assert.equal(opened[0].protocols.includes("admin.admin-secret"), true);
  } finally {
    global.WebSocket = previousWebSocket;
    global.location = previousLocation;
    global.window = previousWindow;
    global.document = previousDocument;
    global.sessionStorage = previousSessionStorage;
    global.localStorage = previousLocalStorage;
  }
});

test("Cloudflare adapter exposes and sends delete-all only for an unlocked admin", async () => {
  const globalAny = /** @type {any} */ (global);
  const previousWebSocket = global.WebSocket;
  const previousLocation = global.location;
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousSessionStorage = global.sessionStorage;
  const previousLocalStorage = global.localStorage;
  const listeners = new Map();
  /** @type {any[]} */
  const sent = [];
  /** @type {any[]} */
  const states = [];
  globalAny.location = { pathname: "/admin/archive" };
  globalAny.window = { prompt: () => "admin-secret", addEventListener() {} };
  globalAny.document = { addEventListener() {}, visibilityState: "visible" };
  globalAny.sessionStorage = { removeItem() {} };
  globalAny.localStorage = { getItem: () => "A".repeat(43), setItem() {} };
  globalAny.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
    }
    /** @param {string} name @param {Function} callback */
    addEventListener(name, callback) {
      listeners.set(name, callback);
    }
    /** @param {string} value */
    send(value) {
      sent.push(JSON.parse(value));
    }
    close() {}
  };
  try {
    const { CloudflareSocket } = await import(
      `../client-data/js/cloudflare_socket_adapter.js?admin-clear=${Date.now()}`
    );
    const socket = new CloudflareSocket("https://worker.invalid", "archive");
    socket.on("boardstate", (/** @type {any} */ state) => states.push(state));
    socket.connect();
    listeners.get("open")();
    assert.equal(states[states.length - 1].canClear, true);
    socket.emit("broadcast", {
      tool: 11,
      type: 6,
      id: "",
      clientMutationId: "cm-admin-clear-123456",
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "admin.delete_all");
    assert.match(sent[0].mutationId, /^mutation_/);
  } finally {
    globalAny.WebSocket = previousWebSocket;
    globalAny.location = previousLocation;
    globalAny.window = previousWindow;
    globalAny.document = previousDocument;
    globalAny.sessionStorage = previousSessionStorage;
    globalAny.localStorage = previousLocalStorage;
  }
});
