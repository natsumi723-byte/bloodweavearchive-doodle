import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error("output_directory_required");
const output = path.resolve(outputArgument);
const adminSecret = process.env.BWA_TEST_ADMIN_SECRET || "";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
/** @type {Array<{name: string, viewport: import("@playwright/test").ViewportSize, url: string, screenshot: string, assertions: string[], consoleMessages: Array<{type: string, text: string}>, requestFailures: Array<{url: string, error: string | undefined}>}>} */
const results = [];

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} selector
 */
async function assertInsideViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} must have a visible box`);
  const viewport = page.viewportSize();
  assert.ok(viewport);
  assert.ok(box.x >= 0 && box.y >= 0, `${selector} starts outside viewport`);
  assert.ok(
    box.x + box.width <= viewport.width,
    `${selector} overflows horizontally`,
  );
  assert.ok(
    box.y + box.height <= viewport.height,
    `${selector} overflows vertically`,
  );
}

/**
 * @param {string} name
 * @param {import("@playwright/test").ViewportSize} viewport
 * @param {string} url
 * @param {(page: import("@playwright/test").Page) => Promise<string[]>} [action]
 */
async function capture(name, viewport, url, action) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  /** @type {Array<{type: string, text: string}>} */
  const consoleMessages = [];
  /** @type {Array<{url: string, error: string | undefined}>} */
  const requestFailures = [];
  page.on("console", (message) =>
    consoleMessages.push({ type: message.type(), text: message.text() }),
  );
  page.on("requestfailed", (request) =>
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText,
    }),
  );
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(750);
  const assertions = action ? await action(page) : [];
  await page.waitForTimeout(300);
  await assertInsideViewport(page, ".bwa-identity");
  if (await page.locator(".bwa-view-controls").isVisible()) {
    await assertInsideViewport(page, ".bwa-view-controls");
  }
  assert.deepEqual(requestFailures, [], `${name} has network failures`);
  const severe = consoleMessages.filter((entry) =>
    ["warning", "error"].includes(entry.type),
  );
  assert.deepEqual(severe, [], `${name} has console warnings/errors`);
  const screenshot = path.join(output, `${name}.png`);
  await page.screenshot({ path: screenshot });
  results.push({
    name,
    viewport,
    url,
    screenshot,
    assertions: [
      "viewport-contained",
      "clean-console-network",
      ...(assertions || []),
    ],
    consoleMessages,
    requestFailures,
  });
  await context.close();
}

const publicZh = "http://127.0.0.1:5043/boards/bwa-release-matrix?lang=zh-CN";
const publicEn = "http://127.0.0.1:5043/boards/bwa-release-matrix?lang=en";
await capture(
  "desktop-public-collapsed-zh",
  { width: 1440, height: 1000 },
  publicZh,
);
await capture(
  "desktop-public-menu-style-zh",
  { width: 1440, height: 1000 },
  publicZh,
  async (page) => {
    await page.locator("#bwaMoreToggle").click();
    await page.locator("#styleSummary").click();
    await assertInsideViewport(page, "#menu");
    await assertInsideViewport(page, "#stylePanel");
    return ["expanded-menu-contained", "style-panel-contained"];
  },
);
await capture(
  "desktop-public-drawing-zoom-en",
  { width: 1440, height: 1000 },
  publicEn,
  async (page) => {
    await page.locator("#toolID-pencil").click();
    await page.mouse.move(500, 420);
    await page.mouse.down();
    await page.mouse.move(650, 500, { steps: 12 });
    await page.mouse.up();
    await page.locator("#drawingArea path").first().waitFor();
    await page.locator("#bwaZoomIn").click();
    assert.ok((await page.locator("#drawingArea path").count()) >= 1);
    return ["live-draw-visible", "zoom-control-operable"];
  },
);
await capture(
  "mobile-menu-style-en",
  { width: 390, height: 844 },
  publicEn,
  async (page) => {
    await page.locator("#bwaMoreToggle").click();
    await page.locator("#styleSummary").click();
    await assertInsideViewport(page, "#menu");
    await assertInsideViewport(page, "#stylePanel");
    return ["mobile-menu-contained", "mobile-style-panel-contained"];
  },
);

await capture(
  "desktop-tools-presence-keyboard-en",
  { width: 1440, height: 1000 },
  publicEn,
  async (page) => {
    await page.locator("#bwaMoreToggle").click();
    const tools = [
      "pencil",
      "straight-line",
      "rectangle",
      "ellipse",
      "text",
      "eraser",
      "hand",
      "grid",
      "download",
      "zoom",
    ];
    for (const tool of tools) {
      const locator = page.locator(`#toolID-${tool}:not([hidden])`);
      await locator.waitFor();
      await assertInsideViewport(page, `#toolID-${tool}`);
    }
    await page.locator("#bwaFocusToggle").click();
    assert.equal(
      await page.locator("#bwaFocusToggle").getAttribute("aria-pressed"),
      "true",
    );
    await page.keyboard.press("Escape");
    return [
      "all-tools-visible-contained",
      "keyboard-return",
      "focus-mode-toggled",
    ];
  },
);

await capture(
  "desktop-presence-self-en",
  { width: 1440, height: 1000 },
  publicEn,
  async (page) => {
    await page.locator("#connectedUsersToggle").click();
    assert.equal(
      await page.locator("#connectedUsersToggle").getAttribute("aria-expanded"),
      "true",
    );
    await assertInsideViewport(page, "#connectedUsersPanel");
    assert.equal(await page.locator("#connectedUsersList > li").count(), 1);
    await page.locator("#connectedUsersToggle").click();
    assert.equal(
      await page.locator("#connectedUsersToggle").getAttribute("aria-expanded"),
      "false",
    );
    return ["self-presence-opened-contained", "presence-toggle-closed"];
  },
);

{
  const collaborationUrl =
    "http://127.0.0.1:5043/boards/bwa-release-convergence-v18?lang=en";
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
  ]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  /** @type {Array<{type: string, text: string}>} */
  const consoleMessages = [];
  /** @type {Array<{url: string, error: string | undefined}>} */
  const requestFailures = [];
  for (const [index, page] of pages.entries()) {
    page.on("console", (message) =>
      consoleMessages.push({
        type: message.type(),
        text: `client-${index + 1}: ${message.text()}`,
      }),
    );
    page.on("requestfailed", (request) =>
      requestFailures.push({
        url: request.url(),
        error: request.failure()?.errorText,
      }),
    );
    await page.goto(collaborationUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document.getElementById("boardStatusIndicator")?.dataset.state ===
        "hidden",
    );
  }
  const [writer, reader] = pages;
  assert.ok(writer && reader);
  const initialReaderPaths = await reader.locator("#drawingArea path").count();
  await writer.locator("#toolID-pencil").click();
  await writer.mouse.move(420, 380);
  await writer.mouse.down();
  await writer.mouse.move(620, 510, { steps: 16 });
  await writer.mouse.up();
  await reader.waitForFunction(
    (initial) =>
      document.querySelectorAll("#drawingArea path").length > Number(initial),
    initialReaderPaths,
  );
  const convergedPathCount = await reader.locator("#drawingArea path").count();
  await reader.reload({ waitUntil: "domcontentloaded" });
  await reader.waitForFunction(
    (expected) =>
      document.querySelectorAll("#drawingArea path").length >= Number(expected),
    convergedPathCount,
  );
  await writer.waitForTimeout(4000);
  await writer.locator("#connectedUsersToggle").click();
  await writer.waitForFunction(
    () =>
      document
        .getElementById("connectedUsersToggle")
        ?.getAttribute("aria-expanded") === "true",
  );
  await assertInsideViewport(writer, "#connectedUsersPanel");
  assert.equal(await writer.locator("#connectedUsersList > li").count(), 2);
  const screenshot = path.join(output, "desktop-two-client-convergence-en.png");
  await writer.screenshot({ path: screenshot });
  assert.deepEqual(
    requestFailures,
    [],
    "two-client convergence has network failures",
  );
  assert.deepEqual(
    consoleMessages.filter((entry) =>
      ["warning", "error"].includes(entry.type),
    ),
    [],
    "two-client convergence has console warnings/errors",
  );
  results.push({
    name: "desktop-two-client-convergence-en",
    viewport: { width: 1280, height: 900 },
    url: collaborationUrl,
    screenshot,
    assertions: [
      "two-independent-clients-connected",
      "remote-stroke-converged",
      "reload-retained-authoritative-stroke",
      "presence-opened-contained",
      "clean-console-network",
    ],
    consoleMessages,
    requestFailures,
  });
  await Promise.all(contexts.map((context) => context.close()));
}

await capture(
  "desktop-admin-locked-zh",
  { width: 1440, height: 1000 },
  "http://127.0.0.1:5043/admin/bwa-release-matrix?lang=zh-CN",
);
if (adminSecret) {
  await capture(
    "desktop-admin-unlocked-zh",
    { width: 1440, height: 1000 },
    "http://127.0.0.1:5043/admin/bwa-release-matrix?lang=zh-CN",
    async (page) => {
      await page.locator("#bwaAdminSecret").fill(adminSecret);
      await page.locator(".wbo-dialog-button-primary").click();
      await page.locator("#bwaMoreToggle").click();
      await page.locator("#toolID-clear:not([hidden])").waitFor();
      await assertInsideViewport(page, "#menu");
      return ["admin-unlocked", "clear-visible", "admin-menu-contained"];
    },
  );
}
await capture(
  "mobile-admin-locked-en",
  { width: 390, height: 844 },
  "http://127.0.0.1:5043/admin/bwa-release-matrix?lang=en",
);

await capture(
  "mobile-admin-cancel-en",
  { width: 390, height: 844 },
  "http://127.0.0.1:5043/admin/bwa-release-matrix?lang=en",
  async (page) => {
    await page.locator(".wbo-dialog-button-secondary").click();
    await page.waitForURL(/\/boards\/bwa-release-matrix/);
    assert.ok(!page.url().includes("/admin/"));
    return ["admin-cancel-returns-public"];
  },
);

await fs.writeFile(
  path.join(output, "browser-log.json"),
  JSON.stringify(results, null, 2),
);
await browser.close();
console.log(JSON.stringify({ ok: true, captures: results.length, output }));
