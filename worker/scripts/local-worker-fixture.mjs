import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

export function localCredential(label) {
	return `${label}_${randomBytes(32).toString("base64url")}`;
}

export function reservePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("fixture_port_unavailable"));
				return;
			}
			const port = address.port;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

function probe(origin) {
	if (origin.startsWith("http://")) return fetch(`${origin}/health`);
	return new Promise((resolve, reject) => {
		const request = https.get(
			`${origin}/health`,
			{ rejectUnauthorized: false },
			resolve,
		);
		request.on("error", reject);
	});
}

async function waitForWorker(origin, child, logs) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(
				`local_worker_exited_${child.exitCode}\n${logs.join("")}`,
			);
		}
		try {
			const response = await probe(origin);
			const status = response.status ?? response.statusCode;
			if (status < 500) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`local_worker_start_timeout\n${logs.join("")}`);
}

export async function startLocalWorker({
	adminOrigin,
	publicOrigin,
	protocol = "http",
	access = { mode: "bypass" },
	vars = {},
}) {
	const port = await reservePort();
	const adminSecret = localCredential("admin");
	const ownershipSecret = localCredential("owner");
	const wrangler = path.join(
		workerRoot,
		"node_modules",
		"wrangler",
		"bin",
		"wrangler.js",
	);
	const args = [
		wrangler,
		"dev",
		"--local",
		"--ip",
		"127.0.0.1",
		"--port",
		String(port),
		"--local-protocol",
		protocol,
		"--var",
		"ENVIRONMENT:test",
		"--var",
		`OWNERSHIP_SECRET:${ownershipSecret}`,
		"--var",
		`ADMIN_SECRET:${adminSecret}`,
		"--var",
		`ALLOWED_PUBLIC_ORIGINS:${publicOrigin}`,
		"--var",
		`ALLOWED_ADMIN_ORIGINS:${adminOrigin}`,
	];
	if (access.mode === "bypass") {
		args.push("--var", "ALLOW_MISSING_ACCESS_ASSERTION:true");
	} else if (access.mode === "local-jwks") {
		args.push(
			"--var",
			`ACCESS_TEAM_DOMAIN:${access.issuer}`,
			"--var",
			`ACCESS_POLICY_AUD:${access.audience}`,
			"--var",
			`ACCESS_JWKS_JSON:${JSON.stringify(access.jwks)}`,
		);
	}
	for (const [key, value] of Object.entries(vars)) {
		args.push("--var", `${key}:${value}`);
	}
	const child = spawn(process.execPath, args, {
		cwd: workerRoot,
		env: { ...process.env, CI: "true", NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const logs = [];
	child.stdout.on("data", (chunk) => logs.push(String(chunk)));
	child.stderr.on("data", (chunk) => logs.push(String(chunk)));
	const origin = `${protocol}://127.0.0.1:${port}`;
	await waitForWorker(origin, child, logs);
	return {
		adminSecret,
		origin,
		port,
		logs,
		async stop() {
			if (child.exitCode !== null) return;
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
					stdio: "ignore",
				});
			} else {
				child.kill("SIGTERM");
			}
			await Promise.race([
				new Promise((resolve) => child.once("exit", resolve)),
				new Promise((resolve) => setTimeout(resolve, 3000)),
			]);
		},
	};
}
