import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error("output_directory_required");
const output = path.resolve(outputArgument);
const adminSecret = process.env.BWA_TEST_ADMIN_SECRET || "";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
/** @type {Array<{name: string, viewport: import("@playwright/test").ViewportSize, url: string, screenshot: string, consoleMessages: Array<{type: string, text: string}>, requestFailures: Array<{url: string, error: string | undefined}>}>} */
const results = [];

/**
 * @param {string} name
 * @param {import("@playwright/test").ViewportSize} viewport
 * @param {string} url
 * @param {(page: import("@playwright/test").Page) => Promise<void>} [action]
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
  if (action) await action(page);
  await page.waitForTimeout(300);
  const screenshot = path.join(output, `${name}.png`);
  await page.screenshot({ path: screenshot });
  results.push({
    name,
    viewport,
    url,
    screenshot,
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
    await page.locator("#bwaZoomIn").click();
  },
);
await capture(
  "mobile-menu-style-en",
  { width: 390, height: 844 },
  publicEn,
  async (page) => {
    await page.locator("#bwaMoreToggle").click();
    await page.locator("#styleSummary").click();
  },
);

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
    },
  );
}
await capture(
  "mobile-admin-locked-en",
  { width: 390, height: 844 },
  "http://127.0.0.1:5043/admin/bwa-release-matrix?lang=en",
);

await fs.writeFile(
  path.join(output, "browser-log.json"),
  JSON.stringify(results, null, 2),
);
await browser.close();
console.log(JSON.stringify({ ok: true, captures: results.length, output }));
