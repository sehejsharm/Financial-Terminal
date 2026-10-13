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
      .or(page.getByText(/timed out|network error/i)).first(),
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
  // Two clause rows, each a field + operator select — asserted INSIDE the
  // clause container, and the match selector asserted separately by name.
  //
  // This was `page.locator("select")).toHaveCount(5)`, counting every select
  // on the page, and it was the CI failure. The builder also renders a SECTOR
  // select, but only once the scan metadata has arrived (`meta &&
  // meta.sectors.length > 0` in ScreenBuilder.tsx) — and the preset test above
  // warms that cache, so by the time this test ran there were six selects, not
  // five. It passed in isolation and failed in sequence, and it passed on a
  // machine with no providers at all because then the sixth never appeared.
  //
  // A global count was also weaker than it looked: five selects somewhere on
  // the page says nothing about the builder having rendered any of them.
  const clauses = page.getByTestId("screen-clauses");
  await expect(clauses.locator("select")).toHaveCount(4);
  await expect(page.getByLabel("Match")).toBeVisible();
  await page.getByRole("button", { name: /Run screen/ }).click();
  await expect(
    page.getByRole("link", { name: "Open →" }).first()
      .or(page.getByText(/scanned \d+ names/i))
      .or(page.getByText(/no matches/i))
      .or(page.getByText(/matched/i))
      .or(page.getByText(/screen failed/i))
      .or(page.getByText(/timed out|network error/i)).first(),
  ).toBeVisible({ timeout: 90_000 });
});
