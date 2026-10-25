const PUBLIC_SNAPSHOT_SCHEMA = "bwa-public-board-snapshot/v1";

export function nextPublicSnapshotAlarm({
  currentAlarm,
  dirtySince,
  now,
  quietMs,
  maxMs,
  rescheduleGranularityMs = 10_000,
}) {
  const deadline = Math.min(now + quietMs, dirtySince + maxMs);
  if (currentAlarm === null || deadline <= currentAlarm) return deadline;
  if (deadline - currentAlarm < rescheduleGranularityMs) return currentAlarm;
  return deadline;
}

export function publicSnapshotKey(boardId) {
  return `boards/${boardId}/latest.json`;
}

export function createPublicSnapshot(snapshot, createdAt = new Date()) {
  if (
    snapshot?.schema !== "bwa-board-snapshot/v1" ||
    !Array.isArray(snapshot.strokes)
  ) {
    throw new Error("invalid_snapshot");
  }
  const candidate = {
    schema: PUBLIC_SNAPSHOT_SCHEMA,
    boardId: snapshot.boardId,
    sequence: snapshot.sequence,
    createdAt: createdAt.toISOString(),
    items: snapshot.strokes
      .filter((stroke) => stroke.deletedAt === null)
      .map((stroke) => ({
        id: stroke.id,
        payload: stroke.payload,
        sequence: stroke.sequence,
      })),
  };
  return validatePublicSnapshot(candidate, candidate.boardId);
}

const ITEM_PATTERN = /^[A-Za-z0-9_-]{8,96}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function itemId(value) {
  return typeof value === "string" && ITEM_PATTERN.test(value) ? value : null;
}

function transform(value) {
  const record = plainRecord(value);
  if (!record) return null;
  const result = {};
  for (const key of ["a", "b", "c", "d", "e", "f"]) {
    if (!finite(record[key])) return null;
    result[key] = record[key];
  }
  return result;
}

function optionalOpacity(value) {
  return value === undefined || finite(value) ? value : null;
}

function projectPublicMutation(value) {
  const mutation = plainRecord(value);
  if (!mutation) return null;
  const tool = mutation.tool;
  const type = mutation.type;
  if (!Number.isSafeInteger(tool) || !Number.isSafeInteger(type)) return null;

  if (type === 1 && tool === 1) {
    const id = itemId(mutation.id);
    if (
      !id ||
      !COLOR_PATTERN.test(mutation.color || "") ||
      !finite(mutation.size) ||
      optionalOpacity(mutation.opacity) === null
    ) return null;
    return {
      tool,
      type,
      id,
      color: mutation.color,
      size: mutation.size,
      ...(mutation.opacity === undefined ? {} : { opacity: mutation.opacity }),
    };
  }
  if (type === 1 && [2, 3, 4].includes(tool)) {
    const id = itemId(mutation.id);
    if (
      !id ||
      !COLOR_PATTERN.test(mutation.color || "") ||
      !finite(mutation.size) ||
      optionalOpacity(mutation.opacity) === null ||
      ![mutation.x, mutation.y, mutation.x2, mutation.y2].every(finite)
    ) return null;
    return {
      tool, type, id, color: mutation.color, size: mutation.size,
      ...(mutation.opacity === undefined ? {} : { opacity: mutation.opacity }),
      x: mutation.x, y: mutation.y,
      x2: mutation.x2, y2: mutation.y2,
    };
  }
  if (type === 1 && tool === 5) {
    const id = itemId(mutation.id);
    if (
      !id ||
      !COLOR_PATTERN.test(mutation.color || "") ||
      !finite(mutation.size) ||
      optionalOpacity(mutation.opacity) === null ||
      !finite(mutation.x) ||
      !finite(mutation.y)
    ) return null;
    return {
      tool, type, id, color: mutation.color, size: mutation.size,
      ...(mutation.opacity === undefined ? {} : { opacity: mutation.opacity }),
      x: mutation.x, y: mutation.y,
    };
  }
  if (type === 2 && tool === 2) {
    const id = itemId(mutation.id);
    if (!id || !finite(mutation.x2) || !finite(mutation.y2)) return null;
    return { tool, type, id, x2: mutation.x2, y2: mutation.y2 };
  }
  if (type === 2 && [3, 4].includes(tool)) {
    const id = itemId(mutation.id);
    if (!id || ![mutation.x, mutation.y, mutation.x2, mutation.y2].every(finite)) return null;
    return { tool, type, id, x: mutation.x, y: mutation.y, x2: mutation.x2, y2: mutation.y2 };
  }
  if (type === 2 && tool === 5) {
    const id = itemId(mutation.id);
    if (!id || typeof mutation.txt !== "string") return null;
    return { tool, type, id, txt: mutation.txt };
  }
  if (type === 2 && tool === 7) {
    const id = itemId(mutation.id);
    const projectedTransform = transform(mutation.transform);
    if (!id || !projectedTransform) return null;
    return { tool, type, id, transform: projectedTransform };
  }
  if (type === 3 && [6, 7].includes(tool)) {
    const id = itemId(mutation.id);
    return id ? { tool, type, id } : null;
  }
  if (type === 4 && tool === 1) {
    const parent = itemId(mutation.parent);
    if (!parent || !finite(mutation.x) || !finite(mutation.y)) return null;
    return { tool, type, parent, x: mutation.x, y: mutation.y };
  }
  if (type === 7 && tool === 7) {
    const id = itemId(mutation.id);
    const newid = itemId(mutation.newid);
    return id && newid ? { tool, type, id, newid } : null;
  }
  return null;
}

export function validatePublicSnapshot(value, expectedBoardId = null) {
  const createdAt = new Date(value?.createdAt || "");
  if (
    value?.schema !== PUBLIC_SNAPSHOT_SCHEMA ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.boardId || "") ||
    (expectedBoardId !== null && value.boardId !== expectedBoardId) ||
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.toISOString() !== value.createdAt ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Array.isArray(value.items) ||
    !value.items.every(
      (item) =>
        itemId(item?.id) !== null &&
        item.payload &&
        typeof item.payload === "object" &&
        !Array.isArray(item.payload) &&
        Array.isArray(item.payload.mutations) &&
        item.payload.mutations.length > 0 &&
        item.payload.mutations.every(
          (mutation) => projectPublicMutation(mutation) !== null,
        ) &&
        Number.isSafeInteger(item.sequence) &&
        item.sequence >= 0,
    )
  ) {
    throw new Error("invalid_public_snapshot");
  }
  return {
    schema: PUBLIC_SNAPSHOT_SCHEMA,
    boardId: value.boardId,
    sequence: value.sequence,
    createdAt: value.createdAt,
    items: value.items.map((item) => ({
      id: item.id,
      payload: {
        mutations: item.payload.mutations.map(projectPublicMutation),
      },
      sequence: item.sequence,
    })),
  };
}

export async function writePublicSnapshot(bucket, snapshot, now = new Date()) {
  if (!bucket) throw new Error("public_snapshot_bucket_missing");
  const value = createPublicSnapshot(snapshot, now);
  const body = JSON.stringify(value);
  await bucket.put(publicSnapshotKey(value.boardId), body, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=60, stale-if-error=86400",
    },
    customMetadata: {
      schema: value.schema,
      sequence: String(value.sequence),
      createdAt: value.createdAt,
    },
  });
  return value;
}

export async function readPublicSnapshot(bucket, boardId) {
  if (!bucket) return null;
  const object = await bucket.get(publicSnapshotKey(boardId));
  if (!object) return null;
  const value = validatePublicSnapshot(await object.json(), boardId);
  return { value, object };
}

