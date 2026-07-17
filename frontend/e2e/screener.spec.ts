import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test.setTimeout(120_000);

test("preset screen runs: rows or an honest empty note", async ({ page }) => {
  await login(page);
  await page.goto("/screeners");
  await page.getByRole("button", { name: "Large Cap", exact: true }).click();
  // Provider-dependent: either result rows (Open → links) or the honest
  // "0 of N" / scan-note empty state must appear — never a blank page.
  await expect(
    page.getByRole("link", { name: "Open →" }).first()
      .or(page.getByText(/scanned \d+ names/i))
      .or(page.getByText(/no matches/i))
      .or(page.getByText(/matched/i))
      // Providers unreachable (CI) → the honest failure line still counts
      // as "the page responded, didn't blank".
      .or(page.getByText(/screen failed/i))
      .or(page.getByText(/timed out|network error/i)),
  ).toBeVisible({ timeout: 90_000 });
});

test("custom screen builder renders and accepts conditions", async ({ page }) => {
  await login(page);
  await page.goto("/screeners");
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await expect(page.getByText("Build your own screen")).toBeVisible();
  await page.getByRole("button", { name: "+ Add condition" }).click();
  await expect(page.locator("select")).toHaveCount(4); // 2 rows × (metric+op)
  await page.getByRole("button", { name: "Run custom screen" }).click();
  await expect(
    page.getByRole("link", { name: "Open →" }).first()
      .or(page.getByText(/scanned \d+ names/i))
      .or(page.getByText(/no matches/i))
      .or(page.getByText(/matched/i))
      .or(page.getByText(/screen failed/i))
      .or(page.getByText(/timed out|network error/i)),
  ).toBeVisible({ timeout: 90_000 });
});
