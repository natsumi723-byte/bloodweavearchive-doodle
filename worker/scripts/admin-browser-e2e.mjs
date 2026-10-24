import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { reservePort, startLocalWorker } from "./local-worker-fixture.mjs";

const workerRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repositoryRoot = path.resolve(workerRoot, "..");
const clientData = path.join(repositoryRoot, "client", "client-data");
const board = `qa-admin-browser-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const sitePort = await reservePort();
const siteOrigin = `http://127.0.0.1:${sitePort}`;
const publicOrigin = `http://public.local.invalid:${sitePort}`;
const worker = await startLocalWorker({
	adminOrigin: siteOrigin,
	publicOrigin,
});
const apiSocketOrigin = worker.origin.replace(/^http/, "ws");
const observed = [];

function fixtureHtml() {
	return `<!doctype html><html><head>
    <meta name="bwa-cloudflare-backend" content="${apiSocketOrigin}">
    <script id="translations" type="application/json">{}</script>
  </head><body>
    <svg id="drawingArea"></svg>
    <button id="bwaZoomOut">-</button><span id="bwaZoomValue"></span><button id="bwaZoomIn">+</button>
    <button id="bwaFocusToggle"></button><button id="bwaMoreToggle"></button>
    <details id="styleTool"><summary id="styleSummary">Style</summary><button id="bwaStyleClose">Close</button></details>
    <button id="bwaAdminExport">Export backup</button>
    <button id="bwaAdminRestore">Restore backup</button>
    <input id="bwaAdminRestoreFile" type="file" accept="application/json,.json" hidden>
    <button id="bwaAdminPurge">Purge old records</button>
    <script type="module">
      import { CloudflareSocket } from "/js/cloudflare_socket_adapter.js";
      import { installBwaChrome } from "/js/bwa_chrome.js";
      const socket = new CloudflareSocket(${JSON.stringify(apiSocketOrigin)}, ${JSON.stringify(board)});
      socket.connect();
      installBwaChrome({
        dom: { board: document.getElementById("drawingArea") },
        viewportState: { controller: { getScale: () => 1, zoomBy: () => {} } },
      });
      window.fixtureSocket = socket;
    </script>
  </body></html>`;
}

const site = http.createServer(async (request, response) => {
	try {
		const url = new URL(request.url || "/", siteOrigin);
		if (url.pathname === `/admin/${board}`) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(fixtureHtml());
			return;
		}
		if (url.pathname.startsWith("/js/")) {
			const file = path.resolve(clientData, `.${url.pathname}`);
			if (!file.startsWith(clientData))
				throw new Error("invalid_fixture_asset");
			response.writeHead(200, {
				"Content-Type": "text/javascript; charset=utf-8",
			});
			response.end(await fs.readFile(file));
			return;
		}
		response.writeHead(404).end("not found");
	} catch (error) {
		response
			.writeHead(500)
			.end(error instanceof Error ? error.message : "fixture_error");
	}
});
await new Promise((resolve) => site.listen(sitePort, "127.0.0.1", resolve));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", ({ request }) => {
	if (request.url.startsWith(worker.origin)) {
		observed.push({ method: request.method, url: request.url });
	}
});

async function unlock(secret) {
	await page.locator("#bwaAdminSecret").fill(secret);
	await page.locator("#bwaAdminUnlock button[type=submit]").click();
}

try {
	await page.goto(`${siteOrigin}/admin/${board}`);
	await unlock("wrong-local-secret");
	await page.locator("#bwaAdminExport").click();
	await page.waitForEvent("dialog").then((dialog) => {
		assert.match(dialog.message(), /Export failed/i);
		return dialog.dismiss();
	});

	await page.reload();
	await unlock(worker.adminSecret);
	await page.waitForFunction(() => window.fixtureSocket?.connected === true);

	const downloadPromise = page.waitForEvent("download");
	await page.locator("#bwaAdminExport").click();
	const download = await downloadPromise;
	const backupPath = await download.path();
	assert.ok(backupPath);
	const backup = await fs.readFile(backupPath, "utf8");
	assert.equal(JSON.parse(backup).snapshot.boardId, board);

	await page.evaluate(() => {
		window.confirm = () => false;
	});
	const purgeBefore = observed.filter((entry) =>
		entry.url.endsWith("/purge"),
	).length;
	await page.locator("#bwaAdminPurge").click();
	assert.equal(
		observed.filter((entry) => entry.url.endsWith("/purge")).length,
		purgeBefore,
	);

	await page.locator("#bwaAdminRestoreFile").setInputFiles({
		name: "backup.json",
		mimeType: "application/json",
		buffer: Buffer.from(backup),
	});
	assert.equal(
		observed.some((entry) => entry.url.endsWith("/restore")),
		false,
	);

	await page.evaluate(() => {
		window.confirm = () => true;
	});
	const purgeDialog = page.waitForEvent("dialog");
	await page.locator("#bwaAdminPurge").click();
	await purgeDialog.then((dialog) => {
		assert.match(dialog.message(), /purged/i);
		return dialog.dismiss();
	});

	await page.locator("#bwaAdminRestoreFile").setInputFiles([]);
	const restoreRequest = page.waitForRequest((request) =>
		request.url().endsWith("/restore"),
	);
	await page.locator("#bwaAdminRestoreFile").setInputFiles({
		name: "backup.json",
		mimeType: "application/json",
		buffer: Buffer.from(backup),
	});
	await restoreRequest;
	await page.waitForTimeout(200);

	const apiRequests = observed.filter((entry) =>
		/\/(export|restore|purge)$/.test(entry.url),
	);
	assert.ok(
		apiRequests.some(
			(entry) => entry.method === "OPTIONS" && entry.url.endsWith("/export"),
		),
	);
	assert.ok(
		apiRequests.some(
			(entry) => entry.method === "GET" && entry.url.endsWith("/export"),
		),
	);
	assert.ok(
		apiRequests.some(
			(entry) => entry.method === "OPTIONS" && entry.url.endsWith("/purge"),
		),
	);
	assert.ok(
		apiRequests.some(
			(entry) => entry.method === "POST" && entry.url.endsWith("/purge"),
		),
	);
	assert.ok(
		apiRequests.some(
			(entry) => entry.method === "OPTIONS" && entry.url.endsWith("/restore"),
		),
		JSON.stringify(apiRequests),
	);
	assert.ok(
		apiRequests.some(
			(entry) => entry.method === "POST" && entry.url.endsWith("/restore"),
		),
	);
	console.log(
		JSON.stringify({
			ok: true,
			board,
			browserOrigin: siteOrigin,
			workerOrigin: worker.origin,
			accessBypass: "local-fixture-only",
			cancel: { purge: true, restore: true },
			failure: { export: true },
			success: { export: true, purge: true, restore: true },
			actualCorsPreflights: true,
			requests: apiRequests,
		}),
	);
} finally {
	await browser.close();
	await new Promise((resolve) => site.close(resolve));
	await worker.stop();
}
