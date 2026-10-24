import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WebSocket } from "ws";
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
	protocol: "https",
});
const apiSocketOrigin = worker.origin.replace(/^https/, "wss");
const observed = [];
const inboxes = new WeakMap();

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

function inboxFor(socket) {
	let inbox = inboxes.get(socket);
	if (inbox) return inbox;
	inbox = { messages: [], waiters: [] };
	inboxes.set(socket, inbox);
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const index = inbox.waiters.findIndex((waiter) =>
			waiter.predicate(message),
		);
		if (index === -1) return inbox.messages.push(message);
		const [waiter] = inbox.waiters.splice(index, 1);
		clearTimeout(waiter.timer);
		waiter.resolve(message);
	});
	return inbox;
}

function nextMessage(socket, predicate = () => true) {
	return new Promise((resolve, reject) => {
		const inbox = inboxFor(socket);
		const index = inbox.messages.findIndex(predicate);
		if (index !== -1) return resolve(inbox.messages.splice(index, 1)[0]);
		const timer = setTimeout(() => reject(new Error("message_timeout")), 5000);
		inbox.waiters.push({ predicate, resolve, reject, timer });
	});
}

function connectOwner(token) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(
			`${apiSocketOrigin}/api/boards/${board}/socket`,
			["bwa-v2", `owner.${token}`],
			{ origin: publicOrigin, rejectUnauthorized: false },
		);
		inboxFor(socket);
		socket.addEventListener("open", () => resolve(socket), { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
}

async function commit(socket, id, payload) {
	const mutationId = `mutation_${crypto.randomUUID().replaceAll("-", "")}`;
	const ack = nextMessage(
		socket,
		(message) => message.mutationId === mutationId,
	);
	socket.send(
		JSON.stringify({ type: "stroke.commit", mutationId, id, payload }),
	);
	const message = await ack;
	assert.equal(message.type, "mutation.ack");
	assert.equal(message.status, "committed");
}

async function remove(socket, id) {
	const mutationId = `mutation_${crypto.randomUUID().replaceAll("-", "")}`;
	const result = nextMessage(
		socket,
		(message) => message.mutationId === mutationId,
	);
	socket.send(JSON.stringify({ type: "stroke.delete", mutationId, id }));
	return result;
}

const ownerToken = "A".repeat(43);
const otherToken = "B".repeat(43);
const itemId = `stroke_${crypto.randomUUID().replaceAll("-", "")}`;
const itemPayload = {
	tool: "pencil",
	color: "#7f293b",
	points: [
		[11, 12],
		[21, 22],
	],
};
const owner = await connectOwner(ownerToken);
await nextMessage(owner, (message) => message.type === "snapshot");
await commit(owner, itemId, itemPayload);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	acceptDownloads: true,
	ignoreHTTPSErrors: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
cdp.on("Network.requestWillBeSent", ({ request }) => {
	if (request.url.startsWith(worker.origin))
		observed.push({ method: request.method, url: request.url });
});

async function unlock(secret) {
	await page.locator("#bwaAdminSecret").fill(secret);
	await page.locator("#bwaAdminUnlock button[type=submit]").click();
}

async function downloadBackup() {
	const downloadPromise = page.waitForEvent("download");
	await page.locator("#bwaAdminExport").click();
	const download = await downloadPromise;
	const backupPath = await download.path();
	assert.ok(backupPath);
	return JSON.parse(await fs.readFile(backupPath, "utf8"));
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
	const backup = await downloadBackup();
	assert.equal(backup.snapshot.boardId, board);
	const backedUpItem = backup.snapshot.strokes.find(
		(item) => item.id === itemId,
	);
	assert.ok(backedUpItem);
	assert.deepEqual(backedUpItem.payload, itemPayload);
	assert.equal(typeof backedUpItem.ownerHash, "string");

	const ownerDelete = await remove(owner, itemId);
	assert.equal(ownerDelete.type, "mutation.ack");
	owner.close();

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
		buffer: Buffer.from(JSON.stringify(backup)),
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
	const restoreResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith("/restore") &&
			response.request().method() === "POST",
	);
	const restoredNavigation = page.waitForNavigation();
	await page.locator("#bwaAdminRestoreFile").setInputFiles({
		name: "backup.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(backup)),
	});
	assert.equal((await restoreResponse).status(), 200);
	await restoredNavigation;
	await unlock(worker.adminSecret);
	await page.waitForFunction(() => window.fixtureSocket?.connected === true);

	const readback = await downloadBackup();
	const restoredItem = readback.snapshot.strokes.find(
		(item) => item.id === itemId,
	);
	assert.ok(restoredItem);
	assert.deepEqual(restoredItem.payload, itemPayload);
	assert.equal(restoredItem.ownerHash, backedUpItem.ownerHash);
	assert.equal(restoredItem.deletedAt, null);

	const other = await connectOwner(otherToken);
	await nextMessage(other, (message) => message.type === "snapshot");
	const denied = await remove(other, itemId);
	assert.equal(denied.type, "error");
	assert.equal(denied.code, "not_item_owner");
	other.close();
	const restoredOwner = await connectOwner(ownerToken);
	await nextMessage(restoredOwner, (message) => message.type === "snapshot");
	const accepted = await remove(restoredOwner, itemId);
	assert.equal(accepted.type, "mutation.ack");
	assert.equal(accepted.status, "committed");
	restoredOwner.close();

	const apiRequests = observed.filter((entry) =>
		/\/(export|restore|purge)$/.test(entry.url),
	);
	for (const [method, action] of [
		["OPTIONS", "export"],
		["GET", "export"],
		["OPTIONS", "purge"],
		["POST", "purge"],
		["OPTIONS", "restore"],
		["POST", "restore"],
	]) {
		assert.ok(
			apiRequests.some(
				(entry) => entry.method === method && entry.url.endsWith(`/${action}`),
			),
			`${method} ${action}`,
		);
	}
	console.log(
		JSON.stringify({
			ok: true,
			board,
			browserOrigin: siteOrigin,
			workerOrigin: worker.origin,
			tls: true,
			accessBypass: "local-fixture-only",
			cancel: { purge: true, restore: true },
			failure: { export: true },
			success: { export: true, purge: true, restore: true },
			actualCorsPreflights: true,
			restoreReadback: {
				itemId,
				payloadExact: true,
				ownerHashPreserved: true,
				deletedAt: null,
				nonOwnerRejected: denied.code,
				ownerAccepted: accepted.status,
				navigationAndReconnect: true,
			},
			requests: apiRequests,
		}),
	);
} finally {
	await browser.close();
	await new Promise((resolve) => site.close(resolve));
	await worker.stop();
}
