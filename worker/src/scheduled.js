import { createGoogleDriveClient, runBackupRotation } from "./backup.js";
import { normalizeBoardId } from "./protocol.js";
import { writePublicSnapshot } from "./public_snapshot.js";

export async function runScheduledBackups(controller, env, overrides = {}) {
  const boardIds = String(env.BACKUP_BOARD_IDS || "")
    .split(",")
    .map((value) => normalizeBoardId(value.trim()))
    .filter(Boolean);
  if (!boardIds.length || !env.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error("backup_not_configured");
  }
  const drive = (overrides.createDrive || createGoogleDriveClient)(env);
  const rotate = overrides.rotate || runBackupRotation;
  const publish = overrides.publish || writePublicSnapshot;
  const jobs = boardIds.map(async (boardId) => {
    const stub = env.BOARDS.get(env.BOARDS.idFromName(boardId));
    await stub.purgeTombstones(controller.scheduledTime, 30);
    const snapshot = await stub.exportSnapshot(boardId);
    const now = new Date(controller.scheduledTime);
    const [rotation] = await Promise.all([
      rotate({
        snapshot,
        drive,
        folderId: env.GOOGLE_DRIVE_FOLDER_ID,
        retention: 30,
        now,
      }),
      publish(env.PUBLIC_SNAPSHOTS, snapshot, now),
    ]);
    return rotation;
  });
  const results = await Promise.allSettled(jobs);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `backup_partial_failure:${failures.length}/${results.length}`,
    );
  }
  return results.map((result) => result.value);
}

export function scheduleBackups(controller, env, ctx, overrides = {}) {
  const completion = runScheduledBackups(controller, env, overrides);
  ctx.waitUntil(completion);
  return completion;
}
