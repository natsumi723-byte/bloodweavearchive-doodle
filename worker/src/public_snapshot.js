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
  return {
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
}

const PROHIBITED_PUBLIC_KEYS = new Set([
  "ownerhash",
  "deletedat",
  "mutationreceipts",
  "adminidentity",
  "secret",
]);

function containsProhibitedKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsProhibitedKey);
  return Object.entries(value).some(
    ([key, child]) =>
      PROHIBITED_PUBLIC_KEYS.has(key.toLowerCase()) ||
      containsProhibitedKey(child),
  );
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
        typeof item?.id === "string" &&
        item.id.length >= 8 &&
        item.payload &&
        typeof item.payload === "object" &&
        !Array.isArray(item.payload) &&
        Array.isArray(item.payload.mutations) &&
        item.payload.mutations.length > 0 &&
        item.payload.mutations.every(
          (mutation) =>
            mutation &&
            typeof mutation === "object" &&
            !Array.isArray(mutation),
        ) &&
        !containsProhibitedKey(item.payload) &&
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
      payload: { mutations: structuredClone(item.payload.mutations) },
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

