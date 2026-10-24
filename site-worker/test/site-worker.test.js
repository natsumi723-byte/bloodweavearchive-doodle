import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker, {
  boardPath,
  canonicalBoardRequest,
  isAdminApiRequest,
  isBoardApiRequest,
  preferredLanguage,
} from "../src/index.js";

test("static assets do not rewrite internal HTML shell fetches", async () => {
  const config = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  assert.equal(config.assets.html_handling, "none");
});

test("language selection only exposes the supported allowlist", () => {
  assert.equal(
    preferredLanguage(
      new URL("https://doodle.example/boards/x?lang=fr"),
      new Request("https://doodle.example/boards/x", {
        headers: { "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" },
      }),
    ),
    "zh-CN",
  );
  assert.equal(
    preferredLanguage(
      new URL("https://doodle.example/boards/x?lang=en"),
      new Request("https://doodle.example/boards/x"),
    ),
    "en",
  );
});

test("board routes are fixed to the governed board id", () => {
  assert.equal(
    boardPath("boards", "bwa-unfinished-archive"),
    "/boards/bwa-unfinished-archive",
  );
  assert.equal(
    canonicalBoardRequest(
      new URL("https://doodle.example/boards/bwa-unfinished-archive"),
      "boards",
      "bwa-unfinished-archive",
    ),
    true,
  );
});

test("public and admin hosts cannot cross into each other's route", async () => {
  const env = {
    BOARD_ID: "bwa-unfinished-archive",
    PUBLIC_HOST: "doodle.example",
    ADMIN_HOST: "admin-doodle.example",
    ASSETS: {
      fetch(request) {
        return new Response(new URL(request.url).pathname, {
          headers: { "content-type": "text/plain" },
        });
      },
    },
  };
  const publicResponse = await worker.fetch(
    new Request("https://doodle.example/admin/bwa-unfinished-archive"),
    env,
  );
  assert.equal(publicResponse.status, 302);
  assert.equal(
    publicResponse.headers.get("location"),
    "https://doodle.example/boards/bwa-unfinished-archive",
  );

  const adminResponse = await worker.fetch(
    new Request("https://admin-doodle.example/boards/bwa-unfinished-archive"),
    env,
  );
  assert.equal(adminResponse.status, 302);
  assert.equal(
    adminResponse.headers.get("location"),
    "https://admin-doodle.example/admin/bwa-unfinished-archive",
  );
});

test("only the Access-protected admin host proxies administrator API traffic", async () => {
  const forwarded = [];
  const env = {
    BOARD_ID: "bwa-unfinished-archive",
    PUBLIC_HOST: "doodle.example",
    ADMIN_HOST: "admin-doodle.example",
    API: {
      fetch(request) {
        forwarded.push(request);
        return new Response("proxied");
      },
    },
    ASSETS: {
      fetch() {
        return new Response("asset");
      },
    },
  };
  const adminUrl = new URL(
    "https://admin-doodle.example/api/admin/boards/archive/socket",
  );
  assert.equal(isAdminApiRequest(adminUrl, adminUrl.hostname, env), true);

  const assertion = "signed-access-assertion";
  const adminRequest = new Request(adminUrl, {
    headers: {
      "Cf-Access-Jwt-Assertion": assertion,
      Origin: "https://admin-doodle.example",
    },
  });
  const adminResponse = await worker.fetch(adminRequest, env);
  assert.equal(await adminResponse.text(), "proxied");
  assert.equal(forwarded.length, 1);
  assert.equal(
    forwarded[0].headers.get("Cf-Access-Jwt-Assertion"),
    assertion,
  );

  const publicResponse = await worker.fetch(
    new Request(
      "https://doodle.example/api/admin/boards/archive/socket",
    ),
    env,
  );
  assert.equal(await publicResponse.text(), "asset");
  assert.equal(forwarded.length, 1);
});

test("same-origin public capacity probes are proxied to the API binding", async () => {
  const forwarded = [];
  const env = {
    BOARD_ID: "bwa-unfinished-archive",
    PUBLIC_HOST: "doodle.example",
    ADMIN_HOST: "admin-doodle.example",
    API: {
      fetch(request) {
        forwarded.push(request);
        return new Response("capacity");
      },
    },
    ASSETS: { fetch: () => new Response("asset") },
  };
  const url = new URL(
    "https://doodle.example/api/boards/archive/socket?capacityProbe=1",
  );
  assert.equal(isBoardApiRequest(url, url.hostname, env), true);
  const response = await worker.fetch(new Request(url), env);
  assert.equal(await response.text(), "capacity");
  assert.equal(forwarded.length, 1);
});
