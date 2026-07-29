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
  await page.route("**/api/v1/market/liquidity**", (r) => {
    const syms = (new URL(r.request().url()).searchParams.get("symbols") || "").split(",");
    const names: Record<string, unknown> = {};
    syms.forEach((sym, i) => {
      // First name is deep, the rest are progressively thinner.
      const adv = [4e9, 8e7, 2e7][i % 3];
      names[sym] = {
        adv_value: adv, median_value: adv, basis_value: adv, adv_shares: 1e6,
        sessions: 20, last_close: 100, participation: 0.15, notional: 1e9,
        days: 1e9 / (adv * 0.15), verdict: "days",
      };
    });
    return r.fulfill({ json: {
      names,
      summary: { names: syms.length, priced: syms.length, unknown: 0,
                 worst_days: 80, median_days: 5, notional_each: 1e9, buckets: {} },
      participation: 0.15, window: 20,
      note: "Days to trade = notional / (ADV × participation). Nothing here "
        + "models market impact or borrow availability.",
    } });
  });
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


test("the exposure view scores concentration and names the choke points",
  async ({ page }) => {
    await openSplc(page);
    await page.getByRole("button", { name: "exposure", exact: true }).click();

    // Hon Hai is 46.6% of input cost on its own — the map is concentrated and
    // has to say so rather than leaving the reader to add up a column.
    await expect(page.getByText(/Largest single counterparty/i)).toBeVisible();
    await expect(page.getByText(/Single points of failure/i)).toBeVisible();
    await expect(page.getByText(/Hon Hai/).first()).toBeVisible();
    // Both the summary and the callout say it; either is enough.
    await expect(page.getByText(/cannot be replaced quickly|passes straight through/i)
      .first()).toBeVisible();
    // The read states its coverage before its conclusion.
    await expect(page.getByText(/relationships carry a figure/)).toBeVisible();
    await expect(page.getByText(/at least this high, not lower/)).toBeVisible();
  });

test("exposure is converted into money using the subject's own financials",
  async ({ page }) => {
    await openSplc(page);
    await page.getByRole("button", { name: "exposure", exact: true }).click();
    await expect(page.getByText(/Exposure in money/i)).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /At risk/i })).toBeVisible();
  });

test("tradability is opt-in, then answers the size question", async ({ page }) => {
  await openSplc(page);
  await page.getByRole("button", { name: "exposure", exact: true }).click();

  // Not automatic: it is the heaviest fetch on the screen.
  const check = page.getByRole("button", { name: "Check tradability" });
  await expect(check).toBeVisible();
  await check.click();

  await expect(page.getByText(/Deployable inside 20 sessions/i)).toBeVisible();
  await expect(page.getByText(/Blocked by liquidity/i)).toBeVisible();
  await expect(page.getByText(/Slowest leg/i)).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Sessions/i })).toBeVisible();
});

test("changing the size changes the day counts", async ({ page }) => {
  await openSplc(page);
  await page.getByRole("button", { name: "exposure", exact: true }).click();
  await page.getByRole("button", { name: "Check tradability" }).click();
  await expect(page.getByText(/Slowest leg/i)).toBeVisible();

  const slowest = () => page.getByText(/Slowest leg/i).locator("..").locator(".num").first();
  const big = await slowest().textContent();
  await page.getByRole("button", { name: "$100m", exact: true }).click();
  await expect(slowest()).not.toHaveText(big!);
});

test("the exposure view never renders the graph underneath it", async ({ page }) => {
  // Both were mounted at once at first: the chart kept rendering below the
  // analysis, which reads as a duplicated screen.
  await openSplc(page);
  await page.getByRole("button", { name: "exposure", exact: true }).click();
  await expect(page.getByPlaceholder("Find in graph…")).toBeHidden();
});
