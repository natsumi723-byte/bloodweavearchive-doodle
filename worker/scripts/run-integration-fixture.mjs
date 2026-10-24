import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reservePort, startLocalWorker } from "./local-worker-fixture.mjs";

const workerRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const originPort = await reservePort();
const origin = `http://127.0.0.1:${originPort}`;
const worker = await startLocalWorker({
	adminOrigin: origin,
	publicOrigin: origin,
	vars: { BOARD_MAX_ITEMS: 3 },
});
const board = `qa-public-fixture-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

try {
	const result = await new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				path.join(workerRoot, "scripts", "integration-check.mjs"),
				`${worker.origin.replace(/^http/, "ws")}/api/boards/${board}/socket`,
			],
			{
				cwd: workerRoot,
				env: {
					...process.env,
					INTEGRATION_ADMIN_SECRET: worker.adminSecret,
					INTEGRATION_ORIGIN: origin,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve(JSON.parse(stdout.trim()))
				: reject(
						new Error(
							`integration_fixture_failed_${code}\n${stdout}\n${stderr}`,
						),
					),
		);
	});
	assert.equal(result.ok, true);
	console.log(
		JSON.stringify({ ...result, board, accessBypass: "local-fixture-only" }),
	);
} finally {
	await worker.stop();
}
