const PUBLIC_SNAPSHOT_SCHEMA = "bwa-public-board-snapshot/v1";

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

export function validatePublicSnapshot(value) {
  if (
    value?.schema !== PUBLIC_SNAPSHOT_SCHEMA ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.boardId || "") ||
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
        Number.isSafeInteger(item.sequence) &&
        item.sequence >= 0,
    )
  ) {
    throw new Error("invalid_public_snapshot");
  }
  return value;
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
  const value = validatePublicSnapshot(await object.json());
  return { value, object };
}

