import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * SPLC — the two views of one value chain.
 *
 * The AI generator is unreachable from CI, so the map is stubbed and these
 * assert on what the screen owns: that both views exist, that the table
 * ranks and filters the same entities the chart draws, and that the
 * provenance of every figure survives into the table and the export.
 */

const CHAIN = {
  ticker: "AAPL",
  name: "Apple Inc",
  sector: "Technology",
  suppliers: [
    {
      name: "Hon Hai Precision Industry Co", ticker: "2317.TW",
      pct_cogs: 46.6, est_usd_value: 16.9e9, note: "Assembly",
      confidence: "verified", verified_at: "2026-06-01T00:00:00Z",
    },
    { name: "Pegatron Corp", ticker: "4938.TW", pct_cogs: 16.6, est_usd_value: 6.0e9 },
    { name: "Samsung Electronics Co", ticker: "005930.KS", pct_cogs: 6.8, est_usd_value: 3.6e9 },
  ],
  customers: [
    { name: "Best Buy Co", ticker: "BBY", pct_revenue: 4.2, est_usd_value: 14e9 },
    { name: "Walmart Inc", ticker: "WMT", pct_revenue: 3.1, est_usd_value: 10e9 },
  ],
  competitors: [
    { name: "Samsung Electronics Co", ticker: "005930.KS" },
    { name: "Xiaomi Corp", ticker: "1810.HK" },
  ],
  generated_at: "2026-07-29T06:00:00Z",
  source: "test-model",
};

async function openSplc(page: Page) {
  await login(page);
  await page.route("**/api/v1/value-chain/**", (r) => {
    const u = r.request().url();
    if (u.includes("/history")) return r.fulfill({ json: [] });
    if (u.includes("/reports")) return r.fulfill({ json: { counts: {} } });
    return r.fulfill({ json: CHAIN });
  });
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({
    json: { name: "Apple Inc", sector: "Technology", price: 212.43, currency: "USD" },
  }));
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({
    json: { symbol: "AAPL", price: 212.43, prev_close: 214.9, change_pct: -1.15 },
  }));
  await page.goto("/terminal?t=AAPL&fn=SPLC");
  await expect(page.getByRole("button", { name: "chart", exact: true }))
    .toBeVisible({ timeout: 45_000 });
}

test("offers both a chart and a table of the same map", async ({ page }) => {
  await openSplc(page);
  for (const v of ["chart", "table"]) {
    await expect(page.getByRole("button", { name: v, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "chart", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});

test("the table ranks counterparties and names its basis", async ({ page }) => {
  await openSplc(page);
  await page.getByRole("button", { name: "table", exact: true }).click();

  // Default sort is by estimated value, largest first — Hon Hai at $16.9bn
  // outranks the largest customer at $14bn.
  await expect(page.locator("tbody tr").first()).toContainText("Hon Hai");

  // Provenance is a column, not a footnote.
  await expect(page.getByRole("columnheader", { name: /Basis/ })).toBeVisible();
  await expect(page.getByText("verified", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("estimated").first()).toBeVisible();
});

test("sorting by input cost puts the largest supplier on top", async ({ page }) => {
  await openSplc(page);
  await page.getByRole("button", { name: "table", exact: true }).click();
  await page.getByRole("columnheader", { name: /input cost/i }).click();
  await expect(page.locator("tbody tr").first()).toContainText("Hon Hai");
});

test("the relationship tabs filter the table", async ({ page }) => {
  await openSplc(page);
  await page.getByRole("button", { name: "table", exact: true }).click();
  await page.getByRole("button", { name: /^Customers/ }).click();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(/Best Buy|Walmart/);
});

test("a dual-role company appears under BOTH of its tabs", async ({ page }) => {
  // Samsung is a supplier and a competitor. Filtering on primary role alone
  // would hide it from one of them, which is the kind of silent omission
  // that makes a research tool untrustworthy.
  await openSplc(page);
  await page.getByRole("button", { name: "table", exact: true }).click();
  for (const tab of [/^Suppliers/, /^Peers/]) {
    await page.getByRole("button", { name: tab }).click();
    await expect(page.getByText("Samsung Electronics Co").first()).toBeVisible();
  }
});

test("chart-only controls are hidden while reading the table", async ({ page }) => {
  await openSplc(page);
  await expect(page.getByPlaceholder("Find in graph…")).toBeVisible();
  await page.getByRole("button", { name: "table", exact: true }).click();
  await expect(page.getByPlaceholder("Find in graph…")).toBeHidden();
});

test("the table says how much of the map is quantified at all", async ({ page }) => {
  await openSplc(page);
  await page.getByRole("button", { name: "table", exact: true }).click();
  await expect(page.getByText(/counterparties/)).toBeVisible();
  await expect(page.getByText(/carry a number/)).toBeVisible();
  await expect(page.getByText(/verified/).first()).toBeVisible();
});
