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

test("concurrent dismissal pointers remain isolated by identity", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("mobile-more-menu-multipointer-dismiss");
  const toggle = page.locator("#bwaMoreToggle");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const result = await page.evaluate(() => {
    const board = document.getElementById("board");
    const canvas = document.getElementById("canvas");
    if (!board || !canvas) throw new Error("Missing board surface");
    const counts: Record<string, number> = {
      pointerdown: 0,
      pointerup: 0,
      click: 0,
    };
    for (const type of Object.keys(counts))
      board.addEventListener(type, () => {
        counts[type] += 1;
      });
    const send = (type: string, pointerId: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "touch",
          isPrimary: pointerId === 41,
        }),
      );

    const canceled = [
      send("pointerdown", 41),
      send("pointerdown", 42),
      send("pointerup", 42),
      send("click", 42),
      send("pointerup", 41),
      send("click", 41),
    ];
    send("pointerdown", 43);
    send("pointerup", 43);
    send("click", 43);
    return { counts, canceled };
  });

  expect(result.canceled).toEqual([false, false, false, false, false, false]);
  expect(result.counts).toEqual({ pointerdown: 1, pointerup: 1, click: 1 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("touch-first dismissal is consumed and stale identities recover", async ({
  boardPage,
  page,
}) => {
  await boardPage.gotoBoard("mobile-more-menu-touch-first-dismiss");
  const toggle = page.locator("#bwaMoreToggle");
  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const result = await page.evaluate(async () => {
    const board = document.getElementById("board");
    const canvas = document.getElementById("canvas");
    if (!board || !canvas) throw new Error("Missing board surface");
    const counts: Record<string, number> = {
      touchstart: 0,
      pointerdown: 0,
      pointerup: 0,
      click: 0,
    };
    for (const type of Object.keys(counts))
      board.addEventListener(type, () => {
        counts[type] += 1;
      });
    const touch = new Touch({
      identifier: 61,
      target: canvas,
      clientX: 200,
      clientY: 300,
    });
    const touchStart = canvas.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        changedTouches: [touch],
        touches: [touch],
        targetTouches: [touch],
      }),
    );
    const sendPointer = (type: string, pointerId: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: "touch",
          isPrimary: true,
        }),
      );
    const canceled = [
      touchStart,
      sendPointer("pointerdown", 61),
      sendPointer("pointerup", 61),
      sendPointer("click", 61),
    ];

    // Deliberately omit touchend; both identity maps must recover by timeout.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    sendPointer("pointerdown", 62);
    sendPointer("pointerup", 62);
    sendPointer("click", 62);
    return { counts, canceled };
  });

  expect(result.canceled).toEqual([false, false, false, false]);
  expect(result.counts).toEqual({
    touchstart: 0,
    pointerdown: 1,
    pointerup: 1,
    click: 1,
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
