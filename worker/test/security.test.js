import test from "node:test";
import assert from "node:assert/strict";
import {
  hasAccessAssertion,
  hasAdminProtocol,
  originAllowed,
  parseAllowedOrigins,
  socketRoute,
  adminDataRoute,
} from "../src/security.js";
import { correspondingSourceUrl } from "../src/source.js";

test("production health requires an exact corresponding-source URL", () => {
  const releaseSha = "4b4d6cfca2122844b77abf5d16b6f460c034c310";
  const production = {
    ENVIRONMENT: "production",
    SOURCE_REPOSITORY: "natsumi723-byte/bloodweavearchive-doodle",
    RELEASE_GIT_SHA: releaseSha,
  };
  assert.equal(correspondingSourceUrl({ ENVIRONMENT: "production" }), null);
  assert.equal(
    correspondingSourceUrl({
      ...production,
      CORRESPONDING_SOURCE_URL: "https://github.com/lovasoa/whitebophir",
    }),
    null,
  );
  assert.equal(
    correspondingSourceUrl({
      ...production,
      CORRESPONDING_SOURCE_URL: "http://example.com/source",
    }),
    null,
  );
  assert.equal(
    correspondingSourceUrl({
      ...production,
      CORRESPONDING_SOURCE_URL:
        `https://github.com/natsumi723-byte/bloodweavearchive-doodle/tree/${releaseSha}`,
    }),
    `https://github.com/natsumi723-byte/bloodweavearchive-doodle/tree/${releaseSha}`,
  );
  assert.equal(correspondingSourceUrl({
    ...production,
    CORRESPONDING_SOURCE_URL: "https://github.com/natsumi723-byte/bloodweavearchive-doodle/tree/main",
  }), null);
  assert.equal(correspondingSourceUrl({
    ...production,
    CORRESPONDING_SOURCE_URL: `https://github.com/example/unrelated/tree/${releaseSha}`,
  }), null);
});

test("origin allowlist is exact and fails closed", () => {
  const env = {
    ALLOWED_PUBLIC_ORIGINS: "https://doodle.bloodweavearchive.com",
    ALLOWED_ADMIN_ORIGINS: "https://admin-doodle.bloodweavearchive.com",
  };
  assert.equal(originAllowed(new Request("https://worker.invalid", { headers: { Origin: "https://doodle.bloodweavearchive.com" } }), env, false), true);
  assert.equal(originAllowed(new Request("https://worker.invalid", { headers: { Origin: "https://doodle.bloodweavearchive.com" } }), env, true), false);
  assert.equal(originAllowed(new Request("https://worker.invalid", { headers: { Origin: "https://admin-doodle.bloodweavearchive.com" } }), env, true), true);
  assert.equal(originAllowed(new Request("https://worker.invalid", { headers: { Origin: "https://doodle.bloodweavearchive.com.evil.invalid" } }), env), false);
  assert.equal(originAllowed(new Request("https://worker.invalid"), env), false);
  assert.deepEqual([...parseAllowedOrigins("https://a.test/, https://b.test")], ["https://a.test", "https://b.test"]);
});

test("public and Access-protected admin sockets are distinct routes", () => {
  assert.deepEqual(socketRoute("/api/boards/archive/socket"), { board: "archive", admin: false });
  assert.deepEqual(socketRoute("/api/admin/boards/archive/socket"), { board: "archive", admin: true });
  assert.equal(socketRoute("/api/boards/archive/admin/socket"), null);
});

test("administrator data routes are explicit and bounded", () => {
  assert.deepEqual(adminDataRoute("/api/admin/boards/archive/export"), { board: "archive", action: "export" });
  assert.deepEqual(adminDataRoute("/api/admin/boards/archive/restore"), { board: "archive", action: "restore" });
  assert.deepEqual(adminDataRoute("/api/admin/boards/archive/purge"), { board: "archive", action: "purge" });
  assert.equal(adminDataRoute("/api/admin/boards/archive/delete-all"), null);
});

test("admin credentials fail closed without verified Access configuration", async () => {
  const publicWithAdminSecret = new Request("https://worker.invalid", {
    headers: { "Sec-WebSocket-Protocol": "bwa-v2, admin.secret" },
  });
  const accessRequest = new Request("https://worker.invalid", {
    headers: { "Cf-Access-Jwt-Assertion": "signed-access-token" },
  });
  assert.equal(hasAdminProtocol(publicWithAdminSecret), true);
  assert.equal(await hasAccessAssertion(publicWithAdminSecret), false);
  assert.equal(await hasAccessAssertion(accessRequest), false);
  assert.equal(
    await hasAccessAssertion(publicWithAdminSecret, {
      ALLOW_MISSING_ACCESS_ASSERTION: "true",
    }),
    true,
  );
  assert.equal(
    await hasAccessAssertion(publicWithAdminSecret, {
      ALLOW_MISSING_ACCESS_ASSERTION: "false",
    }),
    false,
  );
});
