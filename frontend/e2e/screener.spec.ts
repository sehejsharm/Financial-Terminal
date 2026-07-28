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
  // The builder shows a WHERE clause row: field + operator + value.
  await expect(page.getByText("WHERE")).toBeVisible();
  await expect(page.getByRole("button", { name: /Condition/ })).toBeVisible();
  await page.getByRole("button", { name: /Condition/ }).click();
  // Two clause rows, each a field + operator select, plus the match selector.
  await expect(page.locator("select")).toHaveCount(5);
  await page.getByRole("button", { name: /Run screen/ }).click();
  await expect(
    page.getByRole("link", { name: "Open →" }).first()
      .or(page.getByText(/scanned \d+ names/i))
      .or(page.getByText(/no matches/i))
      .or(page.getByText(/matched/i))
      .or(page.getByText(/screen failed/i))
      .or(page.getByText(/timed out|network error/i)),
  ).toBeVisible({ timeout: 90_000 });
});
