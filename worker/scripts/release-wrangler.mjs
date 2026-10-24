import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(workerRoot, "..");
const repository = "natsumi723-byte/bloodweavearchive-doodle";
const releaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .trim()
  .toLowerCase();
if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
  throw new Error("invalid_release_git_sha");
}
const sourceUrl = `https://github.com/${repository}/tree/${releaseSha}`;
const wranglerBin = path.join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const args = [
  wranglerBin,
  "deploy",
  "--var",
  `RELEASE_GIT_SHA:${releaseSha}`,
  "--var",
  `CORRESPONDING_SOURCE_URL:${sourceUrl}`,
  ...process.argv.slice(2),
];
const result = spawnSync(process.execPath, args, {
  cwd: workerRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
