import { expect, test } from "../fixtures/test";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("mobile more menu expands by touch", async ({ boardPage, page }) => {
  await boardPage.gotoBoard("mobile-more-menu");

  const toggle = page.locator("#bwaMoreToggle");
  await toggle.tap();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("html")).toHaveAttribute("data-bwa-more", "true");
  await expect(boardPage.tool("grid")).toBeVisible();
  await expect(page.locator("#menu")).toHaveCSS("pointer-events", "auto");
});
