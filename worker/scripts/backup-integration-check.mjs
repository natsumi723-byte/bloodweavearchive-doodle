import fs from "node:fs";
import { createBackupBundle } from "../src/backup.js";

const endpoint = process.argv[2] || "http://127.0.0.1:5042";
const boardId = "qa-backup-lifecycle";
const vars = Object.fromEntries(fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith("#") && line.includes("="))
  .map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1).trim().replace(/^"|"$/g, "")];
  }));
const headers = {
  Origin: "http://127.0.0.1:5043",
  "Cf-Access-Jwt-Assertion": "local-test-assertion",
  Authorization: `Bearer ${vars.ADMIN_SECRET}`,
};
const base = `${endpoint}/api/admin/boards/${boardId}`;

const initialResponse = await fetch(`${base}/export`, { headers });
if (!initialResponse.ok) throw new Error(`initial_export_${initialResponse.status}`);
const initial = await initialResponse.json();
initial.snapshot.sequence += 1;
initial.snapshot.strokes.push({
  id: "stroke_expired_tombstone",
  payload: { mutations: [{ tool: 0, type: 1, id: "stroke_expired_tombstone" }] },
  ownerHash: "c".repeat(64),
  sequence: initial.snapshot.sequence,
  createdAt: Date.now() - 40 * 86400000,
  deletedAt: Date.now() - 31 * 86400000,
});
const restoreBundle = await createBackupBundle(initial.snapshot);
const restore = await fetch(`${base}/restore`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify(restoreBundle),
});
if (!restore.ok) throw new Error(`restore_${restore.status}`);
const purge = await fetch(`${base}/purge`, { method: "POST", headers });
if (!purge.ok) throw new Error(`purge_${purge.status}`);
const purgeResult = await purge.json();
const finalResponse = await fetch(`${base}/export`, { headers });
const finalBundle = await finalResponse.json();
const expiredStillPresent = finalBundle.snapshot.strokes.some((stroke) => stroke.id === "stroke_expired_tombstone");

const tampered = structuredClone(finalBundle);
tampered.snapshot.sequence += 1;
const tamperedResponse = await fetch(`${base}/restore`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify(tampered),
});

console.log(JSON.stringify({
  ok: purgeResult.purged === 1 && !expiredStillPresent && tamperedResponse.status === 400,
  restored: (await restore.json()).restored,
  purged: purgeResult.purged,
  expiredStillPresent,
  tamperedRestoreStatus: tamperedResponse.status,
}));
