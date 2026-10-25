import assert from "node:assert/strict";
import test from "node:test";

import { handlePublicSnapshotRead } from "../src/public_snapshot_route.js";

const boardId = "bwa-unfinished-archive";

function requestFixture({
  ttl = "600",
  cache = null,
  circuit = { take: () => true },
  readSnapshot = async () => null,
  encodedBoardId = boardId,
  query = "?noise=ignored",
} = {}) {
  const url = new URL(`https://api-doodle.bloodweavearchive.com/api/boards/${encodedBoardId}/snapshot${query}`);
  const pending = [];
  let reads = 0;
  return {
    pending,
    get reads() { return reads; },
    async run() {
      const response = await handlePublicSnapshotRead({
        request: new Request(url),
        url,
        env: {
          BACKUP_BOARD_IDS: boardId,
          PUBLIC_SNAPSHOT_CACHE_SECONDS: ttl,
          PUBLIC_SNAPSHOTS: { fixture: true },
        },
        ctx: { waitUntil(promise) { pending.push(promise); } },
        encodedBoardId,
        cache,
        circuit,
        readSnapshot: async (...args) => {
          reads += 1;
          return readSnapshot(...args);
        },
      });
      await Promise.all(pending);
      return response;
    },
  };
}

function successfulSnapshot() {
  return {
    value: {
      schema: "bwa-public-board-snapshot/v1",
      boardId,
      sequence: 1,
      createdAt: "2026-10-25T00:00:00.000Z",
      items: [],
    },
    object: {
      httpEtag: '"fixture"',
      writeHttpMetadata(headers) {
        headers.set("Content-Type", "application/json; charset=utf-8");
      },
    },
  };
}

function assertCacheHeaders(response, browserSeconds, edgeSeconds) {
  assert.equal(response.headers.get("Cache-Control"), `public, max-age=${browserSeconds}`);
  assert.equal(response.headers.get("CDN-Cache-Control"), `public, max-age=${edgeSeconds}`);
}

test("snapshot cache key is canonical and ignores query parameters", async () => {
  let matchedUrl;
  const fixture = requestFixture({
    cache: {
      async match(request) {
        matchedUrl = request.url;
        return new Response("cached", { status: 200 });
      },
    },
  });
  const response = await fixture.run();
  assert.equal(await response.text(), "cached");
  assert.equal(matchedUrl, `https://api-doodle.bloodweavearchive.com/api/boards/${boardId}/snapshot`);
  assert.equal(fixture.reads, 0);
});

test("cache match rejection fails closed before circuit and R2", async () => {
  let circuitCalls = 0;
  const fixture = requestFixture({
    cache: { async match() { throw new Error("cache-read-failure"); } },
    circuit: { take() { circuitCalls += 1; return true; } },
  });
  const response = await fixture.run();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "snapshot_cache_unavailable");
  assert.equal(response.headers.get("Retry-After"), "60");
  assertCacheHeaders(response, 10, 60);
  assert.equal(circuitCalls, 0);
  assert.equal(fixture.reads, 0);
});

test("missing Cache API uses the bounded R2 path", async () => {
  const fixture = requestFixture({ cache: null });
  const response = await fixture.run();
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "snapshot_not_ready");
  assert.equal(fixture.reads, 1);
  assertCacheHeaders(response, 60, 600);
});

test("snapshot response header matrix never exceeds 600 seconds", async () => {
  const ttlCases = [
    ["60", 60],
    ["600", 600],
    ["900", 600],
    ["invalid", 600],
  ];
  for (const [ttl, expected] of ttlCases) {
    const missing = await requestFixture({ ttl }).run();
    assert.equal(missing.status, 404);
    assertCacheHeaders(missing, 60, expected);

    const success = await requestFixture({
      ttl,
      readSnapshot: async () => successfulSnapshot(),
    }).run();
    assert.equal(success.status, 200);
    assertCacheHeaders(success, 60, expected);
  }

  const unregistered = await requestFixture({ encodedBoardId: "other-board" }).run();
  assert.equal(unregistered.status, 404);
  assertCacheHeaders(unregistered, 300, 600);

  const breaker = await requestFixture({ circuit: { take: () => false } }).run();
  assert.equal(breaker.status, 503);
  assert.equal((await breaker.clone().json()).error, "snapshot_temporarily_limited");
  assert.equal(breaker.headers.get("Retry-After"), "60");
  assertCacheHeaders(breaker, 10, 60);

  const r2Failure = await requestFixture({
    readSnapshot: async () => { throw new Error("r2-failure"); },
  }).run();
  assert.equal(r2Failure.status, 503);
  assert.equal((await r2Failure.clone().json()).error, "snapshot_unavailable");
  assert.equal(r2Failure.headers.get("Retry-After"), "60");
  assertCacheHeaders(r2Failure, 10, 60);
});

for (const failureMode of ["sync", "async"]) {
  for (const responseKind of ["success", "missing", "r2-error"]) {
    test(`cache put ${failureMode} failure preserves ${responseKind} response`, async () => {
      const cache = {
        async match() { return null; },
        put() {
          if (failureMode === "sync") throw new Error("sync-put-failure");
          return Promise.reject(new Error("async-put-failure"));
        },
      };
      const readSnapshot = responseKind === "success"
        ? async () => successfulSnapshot()
        : responseKind === "r2-error"
          ? async () => { throw new Error("r2-failure"); }
          : async () => null;
      const response = await requestFixture({ cache, readSnapshot }).run();
      assert.equal(response.status, responseKind === "success" ? 200 : responseKind === "missing" ? 404 : 503);
    });
  }
}
