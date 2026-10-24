const assert = require("node:assert/strict");
const test = require("node:test");

test("Cloudflare adapter declares that socket snapshots replace SVG baselines", async () => {
  const previousDocument = global.document;
  global.document = /** @type {any} */ ({
    querySelector(/** @type {string} */ selector) {
      return selector === 'meta[name="bwa-cloudflare-backend"]'
        ? { content: "wss://api.example.invalid" }
        : null;
    },
  });
  try {
    const { createCloudflareIo } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    const adapter = createCloudflareIo();
    assert.equal(adapter?.providesCompleteSnapshots, true);
  } finally {
    global.document = previousDocument;
  }
});

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

test("Cloudflare adapter persists hand batches with authoritative tool metadata", async () => {
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
    socket.ws = /** @type {any} */ ({
      readyState: 1,
      send(/** @type {string} */ value) {
        sent.push(JSON.parse(value));
      },
    });

    socket.emit("broadcast", {
      tool: 7,
      _children: [
        {
          type: 2,
          id: "text_12345678",
          transform: { a: 1, b: 0, c: 0, d: 1, e: 120, f: 80 },
        },
      ],
      clientMutationId: "cm-hand-text-123456789",
    });
    socket.flushItem("text_12345678");

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "stroke.batch");
    assert.deepEqual(sent[0].operations, [
      {
        type: "stroke.commit",
        id: "text_12345678",
        payload: {
          mutations: [
            {
              tool: 7,
              type: 2,
              id: "text_12345678",
              transform: { a: 1, b: 0, c: 0, d: 1, e: 120, f: 80 },
            },
          ],
        },
      },
    ]);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare adapter sends a multi-item hand move as one atomic frame", async () => {
  const previousWebSocket = global.WebSocket;
  global.WebSocket = /** @type {any} */ ({ OPEN: 1 });
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    const socket = new CloudflareSocket("https://example.invalid", "board");
    /** @type {any[]} */
    const sent = [];
    /** @type {any[]} */
    const accepted = [];
    socket.ws = /** @type {any} */ ({
      readyState: 1,
      send: (/** @type {string} */ value) => sent.push(JSON.parse(value)),
    });
    socket.on("mutation_accepted", (/** @type {any} */ value) =>
      accepted.push(value),
    );
    socket.emit("broadcast", {
      tool: 7,
      clientMutationId: "cm-hand-many",
      _children: [
        { type: 2, id: "text-a", transform: { e: 10, f: 20 } },
        { type: 2, id: "text-b", transform: { e: 30, f: 40 } },
      ],
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "stroke.batch");
    assert.equal(sent[0].operations.length, 2);
    socket.receive({ type: "mutation.ack", mutationId: sent[0].mutationId });
    assert.deepEqual(
      accepted.map((value) => value.clientMutationIds),
      [["cm-hand-many"]],
    );
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare adapter encodes hand deletes as authoritative tombstone operations", async () => {
  const previousWebSocket = global.WebSocket;
  global.WebSocket = /** @type {any} */ ({ OPEN: 1 });
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    const socket = new CloudflareSocket("https://example.invalid", "board");
    /** @type {any[]} */
    const sent = [];
    socket.ws = /** @type {any} */ ({
      readyState: 1,
      send: (/** @type {string} */ value) => sent.push(JSON.parse(value)),
    });
    socket.emit("broadcast", {
      tool: 7,
      clientMutationId: "cm-hand-delete",
      _children: [
        { type: 2, id: "text-a", transform: { e: 10, f: 20 } },
        { type: 3, id: "text-b" },
      ],
    });

    assert.deepEqual(
      sent[0].operations.map((/** @type {any} */ operation) => operation.type),
      ["stroke.commit", "stroke.delete"],
    );
    assert.equal("payload" in sent[0].operations[1], false);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare adapter flushes a pending create before its hand transform", async () => {
  const previousWebSocket = global.WebSocket;
  global.WebSocket = /** @type {any} */ ({ OPEN: 1 });
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    const socket = new CloudflareSocket("https://example.invalid", "board");
    /** @type {any[]} */
    const sent = [];
    socket.ws = /** @type {any} */ ({
      readyState: 1,
      send: (/** @type {string} */ value) => sent.push(JSON.parse(value)),
    });
    socket.emit("broadcast", {
      tool: 5,
      type: 1,
      id: "new-text",
      txt: "move me",
      clientMutationId: "cm-create",
    });
    socket.emit("broadcast", {
      tool: 7,
      clientMutationId: "cm-move",
      _children: [{ type: 2, id: "new-text", transform: { e: 50, f: 60 } }],
    });

    assert.equal(sent[0].type, "stroke.commit");
    assert.equal(sent[0].payload.mutations[0].type, 1);
    assert.equal(sent[1].type, "stroke.batch");
    assert.equal(sent[1].operations[0].payload.mutations[0].type, 2);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare adapter rejects an atomic hand batch without premature success", async () => {
  const previousWebSocket = global.WebSocket;
  global.WebSocket = /** @type {any} */ ({ OPEN: 1 });
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    const socket = new CloudflareSocket("https://example.invalid", "board");
    /** @type {any[]} */
    const sent = [];
    /** @type {any[]} */
    const accepted = [];
    /** @type {any[]} */
    const rejected = [];
    socket.ws = /** @type {any} */ ({
      readyState: 1,
      send: (/** @type {string} */ value) => sent.push(JSON.parse(value)),
    });
    socket.on("mutation_accepted", (/** @type {any} */ value) =>
      accepted.push(value),
    );
    socket.on("mutation_rejected", (/** @type {any} */ value) =>
      rejected.push(value),
    );
    socket.emit("broadcast", {
      tool: 7,
      clientMutationId: "cm-hand-failure",
      _children: [
        { type: 2, id: "text-a", transform: { e: 10, f: 20 } },
        { type: 2, id: "text-b", transform: { e: 30, f: 40 } },
      ],
    });
    socket.receive({
      type: "error",
      code: "storage_failure",
      mutationId: sent[0].mutationId,
    });

    assert.equal(accepted.length, 0);
    assert.deepEqual(rejected, [
      { reason: "storage_failure", clientMutationIds: ["cm-hand-failure"] },
    ]);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare adapter reuses the atomic hand mutation id after a lost ACK", async () => {
  const previousWebSocket = global.WebSocket;
  global.WebSocket = /** @type {any} */ ({ OPEN: 1 });
  try {
    const { CloudflareSocket } = await import(
      "../client-data/js/cloudflare_socket_adapter.js"
    );
    /** @type {any} */
    const batch = {
      tool: 7,
      clientMutationId: "cm-hand-retry",
      _children: [
        { type: 2, id: "text-a", transform: { e: 10, f: 20 } },
        { type: 2, id: "text-b", transform: { e: 30, f: 40 } },
      ],
    };
    const send = async () => {
      /** @type {any[]} */
      const frames = [];
      const socket = new CloudflareSocket("https://example.invalid", "board");
      socket.ws = /** @type {any} */ ({
        readyState: 1,
        send: (/** @type {string} */ value) => frames.push(JSON.parse(value)),
      });
      socket.emit("broadcast", batch);
      return frames;
    };
    const first = await send();
    const retry = await send();
    assert.deepEqual(
      retry.map((frame) => frame.mutationId),
      first.map((frame) => frame.mutationId),
    );
    assert.equal(Boolean(batch.cloudflareMutationId), true);
  } finally {
    global.WebSocket = previousWebSocket;
  }
});

test("Cloudflare hand mutations remain routable for peers and snapshot refresh", async () => {
  const { CloudflareSocket } = await import(
    "../client-data/js/cloudflare_socket_adapter.js"
  );
  const socket = new CloudflareSocket("https://example.invalid", "board");
  /** @type {any[]} */
  const broadcasts = [];
  socket.on("broadcast", (/** @type {any} */ value) => broadcasts.push(value));
  const mutation = {
    tool: 7,
    type: 2,
    id: "text-moved",
    transform: { a: 1, b: 0, c: 0, d: 1, e: 75, f: 90 },
  };
  socket.receive({
    type: "stroke.batch",
    events: [
      {
        type: "stroke.commit",
        sender: "peer-a",
        payload: { mutations: [mutation] },
      },
    ],
  });
  socket.receive({
    type: "snapshot",
    items: [{ payload: { mutations: [mutation] } }],
  });

  assert.equal(broadcasts[0].mutation.tool, 7);
  assert.deepEqual(broadcasts[0].mutation.transform, mutation.transform);
  assert.equal(broadcasts[1]._children[0].tool, 7);
  assert.deepEqual(broadcasts[1]._children[0].transform, mutation.transform);
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

test("Cloudflare adapter replays a peer deletion through the eraser tool", async () => {
  const { CloudflareSocket } = await import(
    "../client-data/js/cloudflare_socket_adapter.js"
  );
  const socket = new CloudflareSocket("https://example.invalid", "test-board");
  /** @type {any[]} */
  const broadcasts = [];
  socket.on("broadcast", (/** @type {any} */ payload) =>
    broadcasts.push(payload),
  );

  socket.receive({
    type: "stroke.delete",
    id: "stroke_erased_by_peer",
    sender: "socket-user-a",
    sequence: 9,
  });

  assert.deepEqual(broadcasts, [
    {
      seq: 1,
      mutation: {
        tool: 6,
        type: 3,
        id: "stroke_erased_by_peer",
        socket: "socket-user-a",
      },
    },
  ]);
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
  global.location = /** @type {any} */ ({
    pathname: "/admin/archive",
    protocol: "https:",
    host: "admin-doodle.example",
  });
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
      "wss://admin-doodle.example/api/admin/boards/archive/socket",
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
  globalAny.location = {
    pathname: "/admin/archive",
    protocol: "https:",
    host: "admin-doodle.example",
  };
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
