import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.WBO_SILENT = "true";

const testFiles = readdirSync(new URL("../test-node/", import.meta.url))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) =>
    fileURLToPath(new URL(`../test-node/${name}`, import.meta.url)),
  );

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
