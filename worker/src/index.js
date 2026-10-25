import { DurableObject } from "cloudflare:workers";
import { jsonResponse, normalizeBoardId, parseClientMessage, validOwnerToken } from "./protocol.js";
import { ownerHash, verifySecret } from "./ownership.js";
import { adminDataRoute, adminPreflight, hasAccessAssertion, hasAdminProtocol, originAllowed, socketRoute, withAdminCors } from "./security.js";
import { createBackupBundle, validateBackupBundle } from "./backup.js";
import { correspondingSourceUrl } from "./source.js";
import { productionConfigErrors, requireProductionConfig } from "./config.js";
import { scheduleBackups } from "./scheduled.js";
import {
  createSnapshotReadCircuit,
  nextPublicSnapshotAlarm,
  publicSnapshotBoardIds,
  readPublicSnapshot,
  writePublicSnapshot,
} from "./public_snapshot.js";

const snapshotReadCircuit = createSnapshotReadCircuit();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
  ctx?.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
}

function errorFrame(code, mutationId = null) {
  return JSON.stringify({ type: "error", code, mutationId });
}

function presenceUser(attachment) {
  const suffix = String(attachment.ownerHash || "guest").slice(-4).toUpperCase();
  return {
    socketId: attachment.socketId,
    userId: String(attachment.ownerHash || "").slice(0, 16),
    name: `Visitor ${suffix}`,
    color: "#8A3046",
    size: 4,
    lastTool: "hand",
    joinedAt: attachment.joinedAt,
    canEdit: true,
    canClear: attachment.isAdmin === true,
    canBan: false,
    canGrantTemporaryModerator: false,
    position: { x: 2500, y: 2500 },
  };
}

export class BoardRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS strokes (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      owner_hash TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS strokes_sequence ON strokes(sequence)");
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS strokes_active_sequence ON strokes(sequence) WHERE deleted_at IS NULL",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS strokes_tombstone_age ON strokes(deleted_at) WHERE deleted_at IS NOT NULL",
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mutation_log (
      mutation_id TEXT PRIMARY KEY,
      owner_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT,
      response TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS mutation_log_created_at ON mutation_log(created_at)",
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS board_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`);
    this.sql.exec("INSERT OR IGNORE INTO board_meta (key, value) VALUES ('sequence', 0)");
    this.sql.exec("INSERT OR IGNORE INTO board_meta (key, value) VALUES ('write_degraded', 0)");
  }

  async fetch(request) {
    const url = new URL(request.url);
    const boardId = normalizeBoardId(url.searchParams.get("board"));
    if (!boardId) return jsonResponse({ error: "invalid_board" }, 400);
    this.boardId = boardId;
    if (
      request.method === "GET" &&
      url.searchParams.get("capacityProbe") === "1"
    ) {
      return jsonResponse(
        { ok: true, capacity: "available" },
        200,
        { "Cache-Control": "no-store" },
      );
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return jsonResponse({ error: "websocket_required" }, 426);
    }
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",")
      .map((value) => value.trim());
    const token = protocols.find((value) => value.startsWith("owner."))?.slice(6);
    const adminToken = protocols.find((value) => value.startsWith("admin."))?.slice(6);
    const requestedSocketId = protocols.find((value) => value.startsWith("socket."))?.slice(7);
    if (!validOwnerToken(token)) return jsonResponse({ error: "invalid_owner_token" }, 401);
    const secret = this.env.OWNERSHIP_SECRET;
    if (!secret || secret.length < 32) return jsonResponse({ error: "server_not_configured" }, 503);
    const identity = await ownerHash(secret, boardId, token);
    const isAdmin = await verifySecret(adminToken, this.env.ADMIN_SECRET);
    if (adminToken && !isAdmin) return jsonResponse({ error: "invalid_admin_secret" }, 403);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const dropAckOnce = this.env.ENABLE_TEST_FAULTS === "true" &&
      boardId.startsWith("qa-lost-ack-");
    const socketId = /^cf-[0-9a-f-]{36}$/i.test(requestedSocketId || "")
      ? requestedSocketId
      : `cf-${crypto.randomUUID()}`;
    const joinedAt = Date.now();
    server.serializeAttachment({ boardId, ownerHash: identity, isAdmin, dropAckOnce, socketId, joinedAt });
    const degraded = this.isBoardDegraded();
    if (degraded) {
      server.serializeAttachment({ boardId, ownerHash: identity, isAdmin, dropAckOnce, socketId, joinedAt, degraded: true });
    }
    const rows = [...this.sql.exec(
      "SELECT id, payload, sequence FROM strokes WHERE deleted_at IS NULL ORDER BY sequence",
    )];
    server.send(JSON.stringify({
      type: "snapshot",
      items: rows.map((row) => ({ id: row.id, payload: JSON.parse(row.payload), sequence: row.sequence })),
    }));
    const joinedUser = presenceUser(server.deserializeAttachment());
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === server) continue;
      const peerAttachment = peer.deserializeAttachment() || {};
      if (!peerAttachment.socketId) continue;
      server.send(JSON.stringify({ type: "presence.joined", user: presenceUser(peerAttachment) }));
      try { peer.send(JSON.stringify({ type: "presence.joined", user: joinedUser })); } catch {}
    }
    server.send(JSON.stringify({ type: "presence.joined", user: joinedUser }));
    if (degraded) server.send(errorFrame("read_only_degraded"));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "bwa-v2" },
    });
  }

  exportSnapshot(boardId) {
    const normalized = normalizeBoardId(boardId);
    if (!normalized) throw new Error("invalid_board");
    const sequence = [...this.sql.exec("SELECT value FROM board_meta WHERE key = 'sequence'")][0].value;
    const strokes = [...this.sql.exec(
      "SELECT id, payload, owner_hash, sequence, created_at, deleted_at FROM strokes ORDER BY sequence, id",
    )].map((row) => ({
      id: row.id,
      payload: JSON.parse(row.payload),
      ownerHash: row.owner_hash,
      sequence: row.sequence,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }));
    return { schema: "bwa-board-snapshot/v1", boardId: normalized, sequence, strokes };
  }

  restoreSnapshot(snapshot) {
    if (snapshot?.schema !== "bwa-board-snapshot/v1" || !normalizeBoardId(snapshot.boardId) || !Array.isArray(snapshot.strokes)) {
      throw new Error("invalid_snapshot");
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM mutation_log");
      this.sql.exec("DELETE FROM strokes");
      for (const stroke of snapshot.strokes) {
        this.sql.exec(
          "INSERT INTO strokes (id, payload, owner_hash, sequence, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
          stroke.id,
          JSON.stringify(stroke.payload),
          stroke.ownerHash,
          stroke.sequence,
          stroke.createdAt,
          stroke.deletedAt,
        );
      }
      this.sql.exec("UPDATE board_meta SET value = ? WHERE key = 'sequence'", Number(snapshot.sequence) || 0);
    });
    return { restored: snapshot.strokes.length, sequence: Number(snapshot.sequence) || 0 };
  }

  purgeTombstones(now = Date.now(), retentionDays = 30) {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const count = [...this.sql.exec(
      "SELECT COUNT(*) AS count FROM strokes WHERE deleted_at IS NOT NULL AND deleted_at < ?",
      cutoff,
    )][0].count;
    const mutationCount = [...this.sql.exec(
      "SELECT COUNT(*) AS count FROM mutation_log WHERE created_at < ?",
      cutoff,
    )][0].count;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM strokes WHERE deleted_at IS NOT NULL AND deleted_at < ?", cutoff);
      this.sql.exec("DELETE FROM mutation_log WHERE created_at < ?", cutoff);
    });
    return { purged: count, purgedMutationReceipts: mutationCount, cutoff };
  }

  async webSocketMessage(socket, raw) {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      socket.send(errorFrame(parsed.code));
      return;
    }
    const attachment = socket.deserializeAttachment();
    if (!attachment?.ownerHash || !attachment?.boardId) {
      socket.close(1011, "missing_identity");
      return;
    }
    const message = parsed.message;
    if (message.type === "cursor") {
      this.broadcast(message, socket);
      return;
    }
    if (attachment.degraded && !(attachment.isAdmin && message.type === "admin.delete_all")) {
      socket.send(errorFrame("read_only_degraded", message.mutationId));
      return;
    }
    const replay = [...this.sql.exec(
      "SELECT owner_hash, response FROM mutation_log WHERE mutation_id = ?",
      message.mutationId,
    )][0];
    if (replay) {
      if (replay.owner_hash !== attachment.ownerHash && !attachment.isAdmin) {
        socket.send(errorFrame("mutation_id_conflict", message.mutationId));
        return;
      }
      const response = JSON.parse(replay.response);
      socket.send(JSON.stringify({ ...response, duplicate: true }));
      return;
    }
    try {
      const result = this.ctx.storage.transactionSync(() => {
        const dropAck = attachment.dropAckOnce && ![...this.sql.exec(
          "SELECT value FROM board_meta WHERE key = 'fault_drop_ack_once'",
        )][0];
        const applied = this.applyMutation(attachment, message);
        if (dropAck) {
          this.sql.exec(
            "INSERT INTO board_meta (key, value) VALUES ('fault_drop_ack_once', 1)",
          );
        }
        return { ...applied, dropAck };
      });
      if (result.event) this.ctx.waitUntil(this.schedulePublicSnapshot(attachment.boardId));
      if (result.event) this.broadcast(result.event, socket);
      if (message.type === "admin.delete_all") this.markBoardRecovered();
      if (result.dropAck) {
        socket.close(1012, "test_drop_ack_once");
        return;
      }
      socket.send(JSON.stringify(result.ack));
    } catch (error) {
      const code = error instanceof MutationError ? error.code : "storage_failure";
      if (!(error instanceof MutationError) || code === "board_full") {
        this.markBoardDegraded(code);
      }
      socket.send(errorFrame(code, message.mutationId));
    }
  }

  async schedulePublicSnapshot(boardId) {
    if (!this.env.PUBLIC_SNAPSHOTS) return;
    const now = Date.now();
    let dirtySince = this.publicSnapshotDirtySince;
    if (!Number.isFinite(dirtySince)) {
      dirtySince = Number(
        await this.ctx.storage.get("public_snapshot_dirty_since"),
      );
    }
    if (!Number.isFinite(dirtySince)) {
      dirtySince = now;
      await this.ctx.storage.put({
        public_snapshot_board_id: boardId,
        public_snapshot_dirty_since: dirtySince,
      });
    }
    this.publicSnapshotDirtySince = dirtySince;
    const quietMs =
      Math.max(10, Number(this.env.PUBLIC_SNAPSHOT_QUIET_SECONDS || 30)) *
      1000;
    const maxMs =
      Math.max(
        60,
        Number(this.env.PUBLIC_SNAPSHOT_MAX_INTERVAL_SECONDS || 600),
      ) * 1000;
    const currentAlarm = await this.ctx.storage.getAlarm();
    const nextAlarm = nextPublicSnapshotAlarm({
      currentAlarm,
      dirtySince,
      now,
      quietMs,
      maxMs,
    });
    if (nextAlarm !== currentAlarm) await this.ctx.storage.setAlarm(nextAlarm);
  }

  async clearPublicSnapshotSchedule() {
    this.publicSnapshotDirtySince = undefined;
    await this.ctx.storage.delete([
      "public_snapshot_board_id",
      "public_snapshot_dirty_since",
    ]);
  }

  async alarm() {
    if (!this.env.PUBLIC_SNAPSHOTS) return;
    const boardId =
      this.boardId ||
      (await this.ctx.storage.get("public_snapshot_board_id"));
    if (!normalizeBoardId(boardId)) {
      await this.clearPublicSnapshotSchedule();
      return;
    }
    await writePublicSnapshot(
      this.env.PUBLIC_SNAPSHOTS,
      this.exportSnapshot(boardId),
    );
    await this.clearPublicSnapshotSchedule();
  }

  applyMutation(attachment, message, { record = true } = {}) {
    if (message.type === "stroke.batch") {
      const events = [];
      for (let index = 0; index < message.operations.length; index += 1) {
        const operation = message.operations[index];
        const applied = this.applyMutation(
          attachment,
          {
            ...operation,
            mutationId: `${message.mutationId}_${index}`,
            sender: message.sender,
          },
          { record: false },
        );
        if (applied.event) events.push(applied.event);
      }
      const sequence = events.at(-1)?.sequence || this.currentSequence();
      const ack = {
        type: "mutation.ack",
        mutationId: message.mutationId,
        action: message.type,
        sequence,
        affected: events.length,
        status: "committed",
      };
      this.recordMutation(attachment, message, ack);
      return {
        ack,
        event: {
          type: "stroke.batch",
          mutationId: message.mutationId,
          sender: message.sender,
          events,
        },
      };
    }
    if (message.type === "admin.delete_all") {
      if (!attachment.isAdmin) throw new MutationError("admin_required");
      const sequence = this.nextSequence();
      const deletedAt = Date.now();
      const count = [...this.sql.exec(
        "SELECT COUNT(*) AS count FROM strokes WHERE deleted_at IS NULL",
      )][0].count;
      this.sql.exec("UPDATE strokes SET deleted_at = ? WHERE deleted_at IS NULL", deletedAt);
      this.setBoardDegraded(false);
      const ack = {
        type: "mutation.ack",
        mutationId: message.mutationId,
        action: message.type,
        sequence,
        affected: count,
        status: "committed",
      };
      if (record) this.recordMutation(attachment, message, ack);
      return { ack, event: { type: "admin.delete_all", sequence } };
    }
    if (message.type === "stroke.commit") {
      const existing = [...this.sql.exec(
        "SELECT payload, owner_hash FROM strokes WHERE id = ? AND deleted_at IS NULL",
        message.id,
      )][0];
      if (existing) {
        if (!attachment.isAdmin && existing.owner_hash !== attachment.ownerHash) {
          throw new MutationError("not_item_owner");
        }
        const previous = JSON.parse(existing.payload);
        const mutations = [
          ...(Array.isArray(previous?.mutations) ? previous.mutations : []),
          ...(Array.isArray(message.payload?.mutations) ? message.payload.mutations : []),
        ];
        const sequence = this.nextSequence();
        this.sql.exec(
          "UPDATE strokes SET payload = ?, sequence = ? WHERE id = ?",
          JSON.stringify({ mutations }),
          sequence,
          message.id,
        );
        const ack = this.createAck(message, sequence);
        if (record) this.recordMutation(attachment, message, ack);
        return { ack, event: { ...message, sequence } };
      }
      const limit = Number(this.env.BOARD_MAX_ITEMS || 300000);
      const count = [...this.sql.exec("SELECT COUNT(*) AS count FROM strokes WHERE deleted_at IS NULL")][0].count;
      if (count >= limit) {
        throw new MutationError("board_full");
      }
      const now = Date.now();
      const sequence = this.nextSequence();
      try {
        this.sql.exec(
          "INSERT INTO strokes (id, payload, owner_hash, sequence, created_at) VALUES (?, ?, ?, ?, ?)",
          message.id,
          JSON.stringify(message.payload),
          attachment.ownerHash,
          sequence,
          now,
        );
      } catch (error) {
        const duplicate = [...this.sql.exec(
          "SELECT 1 AS present FROM strokes WHERE id = ?",
          message.id,
        )][0];
        if (duplicate) throw new MutationError("duplicate_item");
        throw error;
      }
      const ack = this.createAck(message, sequence);
      if (record) this.recordMutation(attachment, message, ack);
      return { ack, event: { ...message, sequence } };
    }
    const row = [...this.sql.exec("SELECT owner_hash FROM strokes WHERE id = ? AND deleted_at IS NULL", message.id)][0];
    if (!row) {
      throw new MutationError("item_not_found");
    }
    if (!attachment.isAdmin && row.owner_hash !== attachment.ownerHash) {
      throw new MutationError("not_item_owner");
    }
    const deletedAt = Date.now();
    const sequence = this.nextSequence();
    this.sql.exec("UPDATE strokes SET deleted_at = ? WHERE id = ?", deletedAt, message.id);
    const ack = this.createAck(message, sequence);
    if (record) this.recordMutation(attachment, message, ack);
    return { ack, event: { ...message, sequence } };
  }

  nextSequence() {
    this.sql.exec("UPDATE board_meta SET value = value + 1 WHERE key = 'sequence'");
    return [...this.sql.exec("SELECT value FROM board_meta WHERE key = 'sequence'")][0].value;
  }

  currentSequence() {
    return [...this.sql.exec(
      "SELECT value FROM board_meta WHERE key = 'sequence'",
    )][0].value;
  }

  isBoardDegraded() {
    return Number([...this.sql.exec(
      "SELECT value FROM board_meta WHERE key = 'write_degraded'",
    )][0]?.value || 0) === 1;
  }

  setBoardDegraded(degraded) {
    this.sql.exec(
      "UPDATE board_meta SET value = ? WHERE key = 'write_degraded'",
      degraded ? 1 : 0,
    );
  }

  markBoardDegraded(code = "storage_failure") {
    try { this.setBoardDegraded(true); } catch {}
    for (const peer of this.ctx.getWebSockets()) {
      const attachment = peer.deserializeAttachment() || {};
      peer.serializeAttachment({ ...attachment, degraded: true });
      try { peer.send(errorFrame(code)); } catch {}
    }
  }

  markBoardRecovered() {
    for (const peer of this.ctx.getWebSockets()) {
      const attachment = peer.deserializeAttachment() || {};
      peer.serializeAttachment({ ...attachment, degraded: false });
      try { peer.send(JSON.stringify({ type: "board.recovered" })); } catch {}
    }
  }

  createAck(message, sequence) {
    return {
      type: "mutation.ack",
      mutationId: message.mutationId,
      action: message.type,
      id: message.id,
      sequence,
      status: "committed",
    };
  }

  recordMutation(attachment, message, ack) {
    this.sql.exec(
      "INSERT INTO mutation_log (mutation_id, owner_hash, kind, item_id, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      message.mutationId,
      attachment.ownerHash,
      message.type,
      message.id || null,
      JSON.stringify(ack),
      Date.now(),
    );
  }

  webSocketClose(socket) {
    const attachment = socket.deserializeAttachment() || {};
    if (!attachment.socketId) return;
    this.broadcast({ type: "presence.left", socketId: attachment.socketId }, socket);
  }

  webSocketError() {}

  broadcast(message, except = null) {
    const encoded = JSON.stringify(message);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== except) peer.send(encoded);
    }
  }
}

class MutationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const source = correspondingSourceUrl(env);
      const configurationErrors = env.ENVIRONMENT === "production"
        ? productionConfigErrors(env)
        : [];
      if (!source || configurationErrors.length) {
        return jsonResponse({ ok: false, error: "production_config_invalid", configurationErrors }, 503);
      }
      return jsonResponse({ ok: true, storage: "durable-object-sqlite", source });
    }
    const publicSnapshotMatch = url.pathname.match(
      /^\/api\/boards\/([^/]+)\/snapshot$/,
    );
    if (publicSnapshotMatch) {
      if (request.method !== "GET") {
        return jsonResponse({ error: "method_not_allowed" }, 405);
      }
      if (!originAllowed(request, env, false)) {
        return jsonResponse({ error: "origin_not_allowed" }, 403);
      }
      let decodedBoardId;
      try {
        decodedBoardId = decodeURIComponent(publicSnapshotMatch[1]);
      } catch {
        return jsonResponse({ error: "invalid_board" }, 400);
      }
      const boardId = normalizeBoardId(decodedBoardId);
      if (!boardId) return jsonResponse({ error: "invalid_board" }, 400);
      if (!publicSnapshotBoardIds(env.BACKUP_BOARD_IDS).has(boardId)) {
        return jsonResponse({ error: "snapshot_not_found" }, 404, {
          "Cache-Control": "public, max-age=300",
          "CDN-Cache-Control": "public, max-age=3600",
        });
      }
      const cacheSeconds = positiveInteger(env.PUBLIC_SNAPSHOT_CACHE_SECONDS, 600);
      const cache = globalThis.caches?.default;
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
      if (!snapshotReadCircuit.take()) {
        return jsonResponse({ error: "snapshot_temporarily_limited" }, 503, {
          "Cache-Control": "public, max-age=10",
          "CDN-Cache-Control": "public, max-age=60",
          "Retry-After": "60",
        });
      }
      let found;
      try {
        found = await readPublicSnapshot(env.PUBLIC_SNAPSHOTS, boardId);
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
    const dataRoute = adminDataRoute(url.pathname);
    if (dataRoute) {
      if (!originAllowed(request, env, true)) return jsonResponse({ error: "origin_not_allowed" }, 403);
      if (request.method === "OPTIONS") {
        return adminPreflight(request, dataRoute.action);
      }
      const respond = (response) => withAdminCors(request, response);
      if (!await hasAccessAssertion(request, env)) return respond(jsonResponse({ error: "access_required" }, 403));
      const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
      if (!await verifySecret(bearer, env.ADMIN_SECRET)) return respond(jsonResponse({ error: "invalid_admin_secret" }, 403));
      const boardId = normalizeBoardId(dataRoute.board);
      if (!boardId) return respond(jsonResponse({ error: "invalid_board" }, 400));
      const stub = env.BOARDS.get(env.BOARDS.idFromName(boardId));
      if (dataRoute.action === "export" && request.method === "GET") {
        const bundle = await createBackupBundle(await stub.exportSnapshot(boardId));
        return respond(new Response(JSON.stringify(bundle), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="bwa-${boardId}-backup.json"`,
            "Cache-Control": "no-store",
          },
        }));
      }
      if (dataRoute.action === "restore" && request.method === "POST") {
        let bundle;
        try {
          bundle = await validateBackupBundle(await request.text());
        } catch (error) {
          return respond(jsonResponse({ error: error instanceof Error ? error.message : "invalid_backup" }, 400));
        }
        if (bundle.snapshot.boardId !== boardId) return respond(jsonResponse({ error: "backup_board_mismatch" }, 409));
        return respond(jsonResponse(await stub.restoreSnapshot(bundle.snapshot)));
      }
      if (dataRoute.action === "purge" && request.method === "POST") {
        return respond(jsonResponse(await stub.purgeTombstones(Date.now(), 30)));
      }
      return respond(jsonResponse({ error: "method_not_allowed" }, 405));
    }
    const route = socketRoute(url.pathname);
    if (!route) return jsonResponse({ error: "not_found" }, 404);
    if (!originAllowed(request, env, route.admin)) {
      return jsonResponse({ error: "origin_not_allowed" }, 403);
    }
    const capacityProbe =
      request.method === "GET" && url.searchParams.get("capacityProbe") === "1";
    if (route.admin) {
      if (!await hasAccessAssertion(request, env)) return jsonResponse({ error: "access_required" }, 403);
      if (!capacityProbe && !hasAdminProtocol(request)) return jsonResponse({ error: "admin_secret_required" }, 401);
    } else if (hasAdminProtocol(request)) {
      return jsonResponse({ error: "admin_route_required" }, 403);
    }
    const boardId = normalizeBoardId(route.board);
    if (!boardId) return jsonResponse({ error: "invalid_board" }, 400);
    const objectId = env.BOARDS.idFromName(boardId);
    const stub = env.BOARDS.get(objectId);
    const forwarded = new URL(request.url);
    forwarded.searchParams.set("board", boardId);
    try {
      return await stub.fetch(new Request(forwarded, request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/allowed rows read|quota|capacity/i.test(message)) {
        return jsonResponse(
          { error: "capacity_exhausted", retryable: true },
          503,
          { "Cache-Control": "no-store", "Retry-After": "3600" },
        );
      }
      throw error;
    }
  },

  async scheduled(controller, env, ctx) {
    if (env.ENVIRONMENT === "production") requireProductionConfig(env);
    scheduleBackups(controller, env, ctx);
  },
};
