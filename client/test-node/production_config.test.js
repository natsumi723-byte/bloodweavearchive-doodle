import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sha = "0123456789abcdef0123456789abcdef01234567";
const repository = "natsumi723-byte/bloodweavearchive-doodle";

/** @param {Record<string, string>} overrides */
function loadProductionConfiguration(overrides = {}) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'await import("./server/configuration.mjs")'],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        WBO_CLOUDFLARE_BACKEND_URL: "wss://api-doodle.bloodweavearchive.com",
        WBO_SOURCE_REPOSITORY: repository,
        WBO_RELEASE_GIT_SHA: sha,
        WBO_CORRESPONDING_SOURCE_URL: `https://github.com/${repository}/tree/${sha}`,
        ...overrides,
      },
    },
  );
}

test("production client accepts one exact immutable release identity", () => {
  const result = loadProductionConfiguration();
  assert.equal(result.status, 0, result.stderr);
});

test("production client rejects a moving or mismatched source URL", () => {
  assert.notEqual(
    loadProductionConfiguration({
      WBO_CORRESPONDING_SOURCE_URL:
        "https://github.com/natsumi723-byte/bloodweavearchive-doodle/tree/main",
    }).status,
    0,
  );
  assert.notEqual(
    loadProductionConfiguration({
      WBO_RELEASE_GIT_SHA: "f".repeat(40),
    }).status,
    0,
  );
});
