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

test("touching the board dismisses the mobile menu without drawing", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("mobile-more-menu-outside-dismiss");
  const toggle = page.locator("#bwaMoreToggle");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const before = await page.locator("#drawingArea > *").count();
  await page.evaluate(() => {
    const board = document.getElementById("board");
    const counts: Record<string, number> = {
      pointerdown: 0,
      pointerup: 0,
      touchstart: 0,
      touchend: 0,
      click: 0,
    };
    const testWindow = window as typeof window & {
      __mobileDismissBoardEvents?: Record<string, number>;
    };
    testWindow.__mobileDismissBoardEvents = counts;
    for (const type of Object.keys(counts)) {
      board?.addEventListener(type, () => {
        counts[type] += 1;
      });
    }
  });

  await page.touchscreen.tap(200, 300);

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("html")).toHaveAttribute("data-bwa-more", "false");
  await expect(page.locator("#drawingArea > *")).toHaveCount(before);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __mobileDismissBoardEvents?: Record<string, number>;
            }
          ).__mobileDismissBoardEvents,
      ),
    )
    .toEqual({
      pointerdown: 0,
      pointerup: 0,
      touchstart: 0,
      touchend: 0,
      click: 0,
    });

  await page.touchscreen.tap(200, 300);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __mobileDismissBoardEvents?: Record<string, number>;
            }
          ).__mobileDismissBoardEvents?.click,
      ),
    )
    .toBe(1);

  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});
