const BACKUP_SCHEMA = "bwa-board-backup/v1";
const ITEM_ID = /^[A-Za-z0-9_-]{8,128}$/;
const OWNER_HASH = /^[a-f0-9]{64}$/;

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function createBackupBundle(snapshot, now = new Date()) {
  validateSnapshot(snapshot);
  const snapshotJson = JSON.stringify(snapshot);
  const digest = await sha256Hex(snapshotJson);
  return {
    schema: BACKUP_SCHEMA,
    manifest: {
      boardId: snapshot.boardId,
      createdAt: now.toISOString(),
      snapshotSha256: digest,
      activeCount: snapshot.strokes.filter((stroke) => stroke.deletedAt === null).length,
      tombstoneCount: snapshot.strokes.filter((stroke) => stroke.deletedAt !== null).length,
      sequence: snapshot.sequence,
    },
    snapshot,
  };
}

export function validateSnapshot(snapshot) {
  if (snapshot?.schema !== "bwa-board-snapshot/v1" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(snapshot.boardId || "") ||
      !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
      !Array.isArray(snapshot.strokes)) {
    throw new Error("invalid_snapshot");
  }
  const ids = new Set();
  for (const stroke of snapshot.strokes) {
    if (!ITEM_ID.test(stroke?.id || "") || ids.has(stroke.id) ||
        !OWNER_HASH.test(stroke.ownerHash || "") ||
        !Number.isSafeInteger(stroke.sequence) || stroke.sequence < 0 ||
        !Number.isSafeInteger(stroke.createdAt) ||
        !(stroke.deletedAt === null || Number.isSafeInteger(stroke.deletedAt)) ||
        !stroke.payload || typeof stroke.payload !== "object" || Array.isArray(stroke.payload)) {
      throw new Error("invalid_snapshot_item");
    }
    ids.add(stroke.id);
  }
  return snapshot;
}

export async function validateBackupBundle(value) {
  const bundle = typeof value === "string" ? JSON.parse(value) : value;
  if (bundle?.schema !== BACKUP_SCHEMA || !bundle.snapshot || !bundle.manifest) {
    throw new Error("invalid_backup_schema");
  }
  if (bundle.snapshot.boardId !== bundle.manifest.boardId) {
    throw new Error("backup_board_mismatch");
  }
  validateSnapshot(bundle.snapshot);
  const digest = await sha256Hex(JSON.stringify(bundle.snapshot));
  if (digest !== bundle.manifest.snapshotSha256) throw new Error("backup_digest_mismatch");
  return bundle;
}

export async function runBackupRotation({ snapshot, drive, folderId, retention = 30, now = new Date() }) {
  const bundle = await createBackupBundle(snapshot, now);
  const content = JSON.stringify(bundle);
  const safeBoard = snapshot.boardId.replace(/[^a-z0-9-]/g, "-");
  const name = `bwa-${safeBoard}-${now.toISOString().replace(/[:.]/g, "-")}.json`;
  const uploaded = await drive.upload({
    folderId,
    name,
    content,
    appProperties: { bwaBackup: "true", boardId: snapshot.boardId },
  });
  const downloaded = await drive.download(uploaded.id);
  await validateBackupBundle(downloaded);
  const backups = (await drive.list({ folderId, boardId: snapshot.boardId }))
    .filter((item) => item.id !== uploaded.id || item.name === name)
    .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
  for (const expired of backups.slice(retention)) await drive.delete(expired.id);
  return { id: uploaded.id, name, digest: bundle.manifest.snapshotSha256, retained: Math.min(backups.length, retention) };
}

export function createGoogleDriveClient(env, fetchImpl = fetch) {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
  for (const key of required) if (!env[key]) throw new Error(`missing_${key.toLowerCase()}`);
  let accessToken = null;
  async function token() {
    if (accessToken) return accessToken;
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error("google_oauth_failed");
    accessToken = (await response.json()).access_token;
    return accessToken;
  }
  return {
    async upload({ folderId, name, content, appProperties }) {
      const bearer = await token();
      const init = await fetchImpl("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,createdTime", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "application/json",
          "X-Upload-Content-Length": String(new TextEncoder().encode(content).byteLength),
        },
        body: JSON.stringify({ name, parents: [folderId], appProperties }),
      });
      const location = init.headers.get("Location");
      if (!init.ok || !location) throw new Error("google_drive_resumable_init_failed");
      const uploaded = await fetchImpl(location, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: content,
      });
      if (!uploaded.ok) throw new Error("google_drive_upload_failed");
      return uploaded.json();
    },
    async download(id) {
      const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
        headers: { Authorization: `Bearer ${await token()}` },
      });
      if (!response.ok) throw new Error("google_drive_validation_download_failed");
      return response.text();
    },
    async list({ folderId, boardId }) {
      const query = `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`;
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", query);
      url.searchParams.set("fields", "files(id,name,createdTime,appProperties)");
      url.searchParams.set("pageSize", "1000");
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!response.ok) throw new Error("google_drive_list_failed");
      return (await response.json()).files.filter((item) => item.appProperties?.bwaBackup === "true" && item.appProperties?.boardId === boardId);
    },
    async delete(id) {
      const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await token()}` },
      });
      if (!response.ok) throw new Error("google_drive_delete_failed");
    },
  };
}
