import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * SCREENERS' coverage reporting.
 *
 * The page revealed how much of the universe it had scanned only when a screen
 * returned NOTHING — the one case where it matters least. "12 matches" out of
 * 500 names where all 500 were readable is a finding; "12 matches" out of 500
 * where only 60 could be evaluated is a statement about the data provider, and
 * the two rendered identically.
 */

const row = (ticker: string, over: Record<string, unknown> = {}) => ({
  ticker, name: `${ticker} Ltd`, sector: "Energy",
  market_cap: 250_000, pe: 22.4, roe: 15.2, roce: null, eps_growth: 18.3,
  ...over,
});

/** Good coverage: nearly everything in the universe was readable. */
const HEALTHY = {
  rows: [row("RELIANCE"), row("TCS"), row("INFY")],
  scanned: 500, evaluable: 495, note: null,
};

/** The dangerous case: a real-looking result over a mostly-unreadable universe. */
const THIN = {
  rows: [row("RELIANCE"), row("TCS")],
  scanned: 500, evaluable: 60, note: null,
};

/** Every ROCE null, and promoter holding on a minority of rows. */
const SPARSE_COLS = {
  rows: [
    row("A", { roce: null, promoter: 55 }),
    row("B", { roce: null, promoter: null }),
    row("C", { roce: null, promoter: null }),
    row("D", { roce: null, promoter: null }),
  ],
  scanned: 500, evaluable: 480, note: null,
};

const EMPTY = { rows: [], scanned: 500, evaluable: 60, note: "No matches for this screen." };

async function open(page: Page, result: unknown) {
  await login(page);
  await page.route("**/api/v1/screens/**", (r) => r.fulfill({ json: result }));
  await page.goto("/screeners");
}

test("SCREENERS reports its coverage on a result that FOUND something", async ({ page }) => {
  // This is where a coverage problem hides: an empty screen already looks
  // empty, but a screen with rows looks authoritative either way.
  await open(page, THIN);
  await expect(page.getByText(/440 were skipped/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/not names that failed the test/)).toBeVisible();
  await expect(page.getByText(/a real match may well be among them/)).toBeVisible();
});

test("SCREENERS stays brief when the universe was readable", async ({ page }) => {
  await open(page, HEALTHY);
  await expect(page.getByText(/3 matches from 500 names scanned/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/were skipped/)).toHaveCount(0);
});

test("SCREENERS says a dashed column is the FEED, not the companies", async ({ page }) => {
  await open(page, SPARSE_COLS);
  await expect(page.getByText(/Return on capital employed is empty for every row/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/the free feed not carrying the field, not the companies/))
    .toBeVisible();
});

test("SCREENERS warns that ranking a half-empty column ranks coverage", async ({ page }) => {
  await open(page, SPARSE_COLS);
  await expect(page.getByText(/ranks the names the provider happens to cover/))
    .toBeVisible({ timeout: 60_000 });
});

test("SCREENERS labels its columns instead of showing database keys", async ({ page }) => {
  await open(page, HEALTHY);
  const table = page.locator("table").first();
  await expect(table).toBeVisible({ timeout: 60_000 });
  await expect(table.getByRole("columnheader", { name: /EPS growth/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /Market cap/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /eps_growth/ })).toHaveCount(0);
});

test("SCREENERS keeps its coverage note on an empty result too", async ({ page }) => {
  await open(page, EMPTY);
  await expect(page.getByText("No matches for this screen."))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/440 were skipped/)).toBeVisible();
});

test("SCREENERS always says a screen is a starting list", async ({ page }) => {
  await open(page, HEALTHY);
  await expect(page.getByText(/a starting list, not a conclusion/))
    .toBeVisible({ timeout: 60_000 });
});
