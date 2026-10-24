import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker, {
  boardPath,
  canonicalBoardRequest,
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
