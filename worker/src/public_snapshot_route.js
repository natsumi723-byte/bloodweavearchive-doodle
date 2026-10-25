import { jsonResponse, normalizeBoardId } from "./protocol.js";
import {
  createSnapshotReadCircuit,
  publicSnapshotBoardIds,
  publicSnapshotCacheSeconds,
  readPublicSnapshot,
} from "./public_snapshot.js";

const defaultSnapshotReadCircuit = createSnapshotReadCircuit();

function snapshotCacheKey(url, boardId) {
  return new Request(
    `${url.origin}/api/boards/${encodeURIComponent(boardId)}/snapshot`,
    { method: "GET" },
  );
}

function snapshotCacheHeaders(browserSeconds, edgeSeconds) {
  return {
    "Cache-Control": `public, max-age=${browserSeconds}`,
    "CDN-Cache-Control": `public, max-age=${edgeSeconds}`,
  };
}

function cacheSnapshotResponse(cache, cacheKey, response, ctx) {
  if (!cache) return;
  try {
    const pending = Promise.resolve(cache.put(cacheKey, response.clone()))
      .catch(() => undefined);
    ctx?.waitUntil(pending);
  } catch {
    // Cache is an optimization. The already-created response remains authoritative.
  }
}

export async function handlePublicSnapshotRead({
  request,
  url,
  env,
  ctx,
  encodedBoardId,
  cache = globalThis.caches?.default,
  circuit = defaultSnapshotReadCircuit,
  readSnapshot = readPublicSnapshot,
}) {
  let decodedBoardId;
  try {
    decodedBoardId = decodeURIComponent(encodedBoardId);
  } catch {
    return jsonResponse({ error: "invalid_board" }, 400);
  }
  const boardId = normalizeBoardId(decodedBoardId);
  if (!boardId) return jsonResponse({ error: "invalid_board" }, 400);
  if (!publicSnapshotBoardIds(env.BACKUP_BOARD_IDS).has(boardId)) {
    return jsonResponse({ error: "snapshot_not_found" }, 404, {
      "Cache-Control": "public, max-age=300",
      "CDN-Cache-Control": "public, max-age=600",
    });
  }
  const cacheSeconds = publicSnapshotCacheSeconds(
    env.PUBLIC_SNAPSHOT_CACHE_SECONDS,
  );
  const cacheKey = snapshotCacheKey(url, boardId);
  let cached = null;
  try {
    cached = cache ? await cache.match(cacheKey) : null;
  } catch {
    return jsonResponse({ error: "snapshot_cache_unavailable" }, 503, {
      ...snapshotCacheHeaders(10, 60),
      "Retry-After": "60",
    });
  }
  if (cached) return cached;
  if (!circuit.take()) {
    return jsonResponse({ error: "snapshot_temporarily_limited" }, 503, {
      ...snapshotCacheHeaders(10, 60),
      "Retry-After": "60",
    });
  }
  let found;
  try {
    found = await readSnapshot(env.PUBLIC_SNAPSHOTS, boardId);
  } catch {
    const response = jsonResponse({ error: "snapshot_unavailable" }, 503, {
      ...snapshotCacheHeaders(10, 60),
      "Retry-After": "60",
    });
    cacheSnapshotResponse(cache, cacheKey, response, ctx);
    return response;
  }
  if (!found) {
    const response = jsonResponse({ error: "snapshot_not_ready" }, 404, {
      ...snapshotCacheHeaders(60, cacheSeconds),
    });
    cacheSnapshotResponse(cache, cacheKey, response, ctx);
    return response;
  }
  const headers = new Headers();
  found.object.writeHttpMetadata(headers);
  for (const [name, value] of Object.entries(snapshotCacheHeaders(60, cacheSeconds))) {
    headers.set(name, value);
  }
  headers.set("ETag", found.object.httpEtag);
  headers.set("Content-Language", "en");
  headers.set("X-Content-Type-Options", "nosniff");
  const response = new Response(JSON.stringify(found.value), { headers });
  cacheSnapshotResponse(cache, cacheKey, response, ctx);
  return response;
}
