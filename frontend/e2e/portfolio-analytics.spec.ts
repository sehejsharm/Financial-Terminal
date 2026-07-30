import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * PORT's analytics.
 *
 * The page could say what the book was worth. It couldn't say where the money
 * came from, how concentrated it really was, or which holdings supplied the
 * beta — and its only concentration measure was "largest position > 30%",
 * which a three-position book passes while being as undiversified as an equity
 * book gets.
 *
 * The summary is stubbed so these assert arithmetic rather than whatever the
 * providers happen to return (and so they don't wait on socket timeouts).
 */

/** Three positions at a third each: no position over 30%, effective count 3. */
const THREE_EQUAL = {
  portfolio: { id: "p1", name: "Main" },
  positions: [
    { id: "1", ticker: "RELIANCE.NS", qty: 100, cost: 1000, price: 1200,
      sector: "Energy", beta: 1.2, currency: "INR", weight: 33.3 },
    { id: "2", ticker: "TCS.NS", qty: 100, cost: 1000, price: 1200,
      sector: "Technology", beta: 0.8, currency: "INR", weight: 33.3 },
    { id: "3", ticker: "HDFCBANK.NS", qty: 100, cost: 1000, price: 1200,
      sector: "Financial Services", beta: 1.0, currency: "INR", weight: 33.3 },
  ],
  totals: { value: 360_000, cost: 300_000, pnl: 60_000, pnl_pct: 20, day_pnl: 500 },
  sectors: [
    { sector: "Energy", value: 120_000, weight: 33.3 },
    { sector: "Technology", value: 120_000, weight: 33.3 },
    { sector: "Financial Services", value: 120_000, weight: 33.4 },
  ],
  factors: { beta: 1.0, dividend_yield: 0.01, top_weight: 33.3 },
};

/** One winner offsetting one loser: the net is small, the gross is not. */
const OFFSETTING = {
  ...THREE_EQUAL,
  positions: [
    { id: "1", ticker: "WINNER", qty: 100, cost: 100, price: 200,
      sector: "Energy", beta: 2, currency: "INR", weight: 60 },
    { id: "2", ticker: "LOSER", qty: 100, cost: 100, price: 10,
      sector: "Energy", beta: 0.5, currency: "INR", weight: 40 },
  ],
  totals: { value: 21_000, cost: 20_000, pnl: 1_000, pnl_pct: 5, day_pnl: 0 },
  sectors: [{ sector: "Energy", value: 21_000, weight: 100 }],
  factors: { beta: 1.4, dividend_yield: null, top_weight: 60 },
};

async function open(page: Page, summary: unknown, history: unknown[] = []) {
  await login(page);
  await page.route("**/api/v1/portfolio/list", (r) =>
    r.fulfill({ json: [{ id: "p1", name: "Main", positions: 3 }] }));
  await page.route("**/api/v1/portfolio/summary**", (r) => r.fulfill({ json: summary }));
  await page.route("**/api/v1/portfolio/history**", (r) =>
    r.fulfill({ json: { portfolio: { id: "p1", name: "Main" }, points: history } }));
  await page.goto("/portfolio");
}

test("PORT catches a book that a largest-position threshold would pass", async ({ page }) => {
  // Three at a third each: nothing over 30%, and there is no more concentrated
  // equity book. The effective count is the measure that sees it.
  await open(page, THREE_EQUAL);
  // "Concentration" also appears in the sector panel's warning copy.
  await expect(page.getByRole("heading", { name: "Concentration" }))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Effective positions")).toBeVisible();
  await expect(page.getByText(/behaves like 3\.0 equal-sized ones/)).toBeVisible();
  await expect(page.getByText(/would clear a “no position over 30%” rule/)).toBeVisible();
});

test("PORT reports effective SECTORS too, since names fall together", async ({ page }) => {
  await open(page, THREE_EQUAL);
  await expect(page.getByText("Effective sectors")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/twenty names in one industry is one bet/)).toBeVisible();
});

test("PORT measures share of movement against GROSS, not net, P&L", async ({ page }) => {
  // Against the net (+1,000) the winner reads 1,000% and the loser −900%.
  // Against gross both did roughly equal work in opposite directions.
  await open(page, OFFSETTING);
  await expect(page.getByText("Where the P&L came from")).toBeVisible({ timeout: 60_000 });
  // Both tables list these tickers, so scope to the attribution table.
  const attr = page.getByTestId("attribution");
  await expect(attr.getByRole("cell", { name: /WINNER/ })).toBeVisible();
  await expect(attr.getByRole("cell", { name: /LOSER/ })).toBeVisible();
  // 10,000 gain vs 9,000 loss → 52.6% / 47.4%. Never above 100.
  await expect(attr.getByRole("cell", { name: "52.6%" })).toBeVisible();
  await expect(attr.getByRole("cell", { name: "47.4%" })).toBeVisible();
  await expect(page.getByText(/would report 1,000% and −900%/)).toBeVisible();
});

test("PORT says a book carried by one position is that position's story", async ({ page }) => {
  await open(page, OFFSETTING);
  await expect(page.getByText(/A SINGLE position accounts for half/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/not the portfolio's/)).toBeVisible();
});

test("PORT refuses to call unrealised P&L a return", async ({ page }) => {
  await open(page, THREE_EQUAL);
  await expect(page.getByText(/excludes closed positions, dividends received/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/it is not your return/)).toBeVisible();
});

test("PORT attributes the weighted beta to the holdings supplying it", async ({ page }) => {
  await open(page, THREE_EQUAL);
  await expect(page.getByText("Where the market sensitivity comes from"))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/supply the most of it/)).toBeVisible();
  await expect(page.getByText(/the part you could actually act on/)).toBeVisible();
  await expect(page.getByText(/betas also rise together in a selloff/i)).toBeVisible();
});

test("PORT normalises beta over covered value, not total value", async ({ page }) => {
  // Dividing by total would report half the real beta for a book the provider
  // only half covers.
  await open(page, {
    ...THREE_EQUAL,
    positions: [
      { ...THREE_EQUAL.positions[0], beta: 1.5 },
      { ...THREE_EQUAL.positions[1], beta: null },
    ],
    sectors: THREE_EQUAL.sectors.slice(0, 2),
  });
  await expect(page.getByText(/Only 50% of book value carries a beta/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/beta 1\.50/)).toBeVisible();
});

test("PORT holdings can be sorted, and unpriced rows stay last", async ({ page }) => {
  await open(page, {
    ...OFFSETTING,
    positions: [
      ...OFFSETTING.positions,
      { id: "3", ticker: "NOPRICE", qty: 10, cost: 100, price: null, value: null,
        pnl: null, pnl_pct: null, sector: "Energy", beta: null, currency: "INR",
        weight: null },
    ],
  });
  const value = page.getByRole("button", { name: /^Value/ });
  await expect(value).toBeVisible({ timeout: 60_000 });
  await value.click();
  // Descending: the biggest holding first, the unpriced row last regardless.
  const cells = page.getByTestId("holdings").locator("tbody tr td:first-child");
  await expect(cells.first()).toContainText("WINNER");
  await expect(cells.last()).toContainText("NOPRICE");
  // Flip it: the unpriced row must STILL be last — it is unknown, not smallest.
  await value.click();
  await expect(cells.first()).toContainText("LOSER");
  await expect(cells.last()).toContainText("NOPRICE");
});

test("PORT refuses to call its history a time-weighted return", async ({ page }) => {
  // Both value and cost step up when a position is added, so growth from
  // contributing money is indistinguishable from growth from performance.
  await open(page, THREE_EQUAL, [
    { date: "2026-06-01", value: 100_000, cost: 100_000, unrealized: 0, realized_cum: 0 },
    { date: "2026-06-02", value: 70_000, cost: 100_000, unrealized: -30_000, realized_cum: 0 },
    { date: "2026-06-03", value: 120_000, cost: 100_000, unrealized: 20_000, realized_cum: 0 },
  ]);
  await expect(page.getByText("Worst drawdown")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/NOT time-weighted returns/)).toBeVisible();
  await expect(page.getByText(/gaps are missing observations rather than flat markets/))
    .toBeVisible();
  // -30% peak-to-trough, which a +20% P&L figure hides entirely. The figure
  // repeats in the drawdown caveat sentence, so take the tile.
  await expect(page.getByText("-30.0%").first()).toBeVisible();
});
