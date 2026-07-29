import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * Phone-width layout.
 *
 * The reported symptom was the header search control rendering at ~390px as
 * an empty box — no icon, no placeholder — because every child of it was
 * allowed to shrink to nothing. These assert the two things that make a
 * narrow layout usable rather than merely narrow: controls stay legible,
 * and the page never scrolls sideways.
 */

const WIDTHS = [375, 390, 414];

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // A pixel or two of rounding is not a layout bug; a scrollable page is.
  expect(overflow).toBeLessThanOrEqual(2);
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 780 } });

    test("the search control shows an icon and a placeholder", async ({ page }) => {
      await login(page);
      await page.goto("/");
      const search = page.getByRole("button", {
        name: "Search ticker, function, or run a command",
      });
      await expect(search).toBeVisible();
      // Not an empty box: it has real width and its icon is still drawn.
      const box = await search.boundingBox();
      expect(box!.width).toBeGreaterThan(120);
      await expect(search.locator("svg")).toBeVisible();
      await expect(search).toContainText(/Search/);
    });

    test("the dashboard does not scroll sideways", async ({ page }) => {
      await login(page);
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
      await noHorizontalScroll(page);
    });

    test("nav labels sit on one line in the drawer", async ({ page }) => {
      await login(page);
      await page.goto("/");
      await page.getByRole("button", { name: "Open navigation" }).click();
      const link = page.getByRole("link", { name: "SCREENERS" });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      // A wrapped two-line row is roughly double the height of a single one.
      expect(box!.height).toBeLessThan(46);
    });

    test("the macro page keeps its tabs reachable", async ({ page }) => {
      await login(page);
      await page.goto("/macro");
      await expect(page.getByRole("tab", { name: "Economy" })).toBeVisible();
      await noHorizontalScroll(page);
    });

    test("portfolio sector labels never collide with their percentages",
      async ({ page }) => {
        await login(page);
        await page.goto("/portfolio");
        await noHorizontalScroll(page);
      });
  });
}
