import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * CF, ANR, OWN and DES.
 *
 * Each of these used to print a provider frame and stop. The assertions here
 * are on the thing that was missing in each case: the comparison, the
 * distribution, the concentration, the performance.
 */

const COMPS = [
  { Ticker: "RELIANCE", Name: "Reliance Industries", "P/E": 24.0, "Fwd P/E": 21.0,
    "P/B": 2.1, "P/S": 1.9, "EV/EBITDA*": 11.0, "ROE%": 8.9 },
  { Ticker: "ONGC", Name: "ONGC", "P/E": 8.0, "Fwd P/E": 7.5,
    "P/B": 0.9, "P/S": 0.6, "EV/EBITDA*": 4.2, "ROE%": 16.1 },
  { Ticker: "IOC", Name: "Indian Oil", "P/E": 9.5, "Fwd P/E": 8.8,
    "P/B": 1.1, "P/S": 0.3, "EV/EBITDA*": 5.0, "ROE%": 14.2 },
  { Ticker: "BPCL", Name: "BPCL", "P/E": 10.5, "Fwd P/E": 9.4,
    "P/B": 1.6, "P/S": 0.4, "EV/EBITDA*": 5.8, "ROE%": 18.0 },
  { Ticker: "GAIL", Name: "GAIL", "P/E": 11.0, "Fwd P/E": 10.2,
    "P/B": 1.3, "P/S": 0.7, "EV/EBITDA*": 6.4, "ROE%": 12.5 },
];

// Upgrade cycle: hold-heavy three months ago, buy-heavy now.
const RATINGS = {
  targets: { low: 1180, mean: 1620, median: 1600, high: 2100, current: 1425.6 },
  recommendations: {
    columns: ["period", "strongBuy", "buy", "hold", "sell", "strongSell"],
    rows: [
      { period: "-2m", strongBuy: 1, buy: 3, hold: 8, sell: 1, strongSell: 0 },
      { period: "-1m", strongBuy: 3, buy: 5, hold: 5, sell: 1, strongSell: 0 },
      { period: "0m", strongBuy: 7, buy: 6, hold: 2, sell: 0, strongSell: 0 },
    ],
  },
};

const OWNERSHIP = {
  major_holders: { columns: ["Breakdown", "Value"], rows: [
    { Breakdown: "% held by insiders", Value: "50.3%" },
    { Breakdown: "% held by institutions", Value: "23.1%" },
  ] },
  institutional_holders: {
    columns: ["Holder", "Shares", "% Out", "Value"],
    rows: [
      { Holder: "Life Insurance Corp of India", Shares: 4.2e8, "% Out": 6.4, Value: 6e11 },
      { Holder: "SBI Mutual Fund", Shares: 2.1e8, "% Out": 3.2, Value: 3e11 },
      { Holder: "Vanguard Group", Shares: 1.4e8, "% Out": 2.1, Value: 2e11 },
      { Holder: "BlackRock", Shares: 1.1e8, "% Out": 1.7, Value: 1.6e11 },
      { Holder: "HDFC AMC", Shares: 0.9e8, "% Out": 1.4, Value: 1.3e11 },
      { Holder: "ICICI Pru", Shares: 0.6e8, "% Out": 0.9, Value: 0.9e11 },
    ],
  },
  mutualfund_holders: { columns: ["Holder", "% Out"], rows: [] },
  officers: [{ name: "A Director", title: "Chairman", pay: 1.5e8, age: 66 }],
};

const DAY = 86_400_000;
function history() {
  const end = Date.UTC(2026, 5, 30);
  // 420 sessions, rising with a visible mid-window drawdown.
  return Array.from({ length: 420 }, (_, i) => {
    const drift = 100 * 1.0012 ** i;
    const dip = i > 200 && i < 260 ? 0.7 : 1;
    return { time: new Date(end - (419 - i) * DAY).toISOString(), close: drift * dip,
             open: drift * dip, high: drift * dip * 1.01, low: drift * dip * 0.99,
             volume: 5e6 };
  });
}

async function open(page: Page, fn: string) {
  await login(page);
  await page.route("**/fundamentals/comps**", (r) => r.fulfill({ json: COMPS }));
  await page.route("**/peers**", (r) => r.fulfill({ json: {
    peers: COMPS.map((c) => c.Ticker), basis: "sector+exchange", sector: "Energy" } }));
  await page.route("**/ratings**", (r) => r.fulfill({ json: RATINGS }));
  await page.route("**/ownership**", (r) => r.fulfill({ json: OWNERSHIP }));
  await page.route("**/api/v1/market/history/**", (r) => r.fulfill({ json: {
    ticker: "RELIANCE.NS", period: "1Y", candles: history() } }));
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({ json: {
    name: "Reliance Industries Ltd", sector: "Energy", price: 1425.6,
    currency: "INR", trailing_pe: 24.0, forward_pe: 21.0, beta: 0.98,
    eps_trailing: 59.4, dividend_yield: 0.004, roe: 0.089, profit_margin: 0.078,
    debt_to_equity: 39.5 } }));
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({ json: {
    symbol: "RELIANCE.NS", price: 1425.6, prev_close: 1440.2, change_pct: -1.01 } }));
  await page.goto(`/terminal?t=RELIANCE.NS&fn=${fn}`);
}

test("CF says whether the name is cheap or dear, not just the numbers", async ({ page }) => {
  await open(page, "CF");
  // Reliance at 24x against a peer median of 10.5x.
  await expect(page.getByText(/vs median/).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/expensive/).first()).toBeVisible();
  await expect(page.getByText(/trades above the peer median/)).toBeVisible();
});

test("CF warns that a discount is not automatically an opportunity", async ({ page }) => {
  await open(page, "CF");
  await expect(page.getByText(/not automatically an opportunity/))
    .toBeVisible({ timeout: 45_000 });
});

test("CF ranks the subject within the peer set", async ({ page }) => {
  await open(page, "CF");
  // Highest P/E of five names.
  await expect(page.getByText(/rank 5\/5/).first()).toBeVisible({ timeout: 45_000 });
});

test("ANR shows the distribution and reads a falling score as an upgrade",
  async ({ page }) => {
    // The scale runs 1 (strong buy) to 5, so a falling score is an upgrade.
    // Reading the sign the natural way calls this a downgrade.
    await open(page, "ANR");
    await expect(page.getByText(/Consensus/).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("upgrading")).toBeVisible();
    await expect(page.getByText(/Where the ratings sit/)).toBeVisible();
    await expect(page.getByText(/How it has moved/)).toBeVisible();
  });

test("ANR says a rating is a poor timing signal", async ({ page }) => {
  await open(page, "ANR");
  await expect(page.getByText(/poor timing signal/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/structurally long/)).toBeVisible();
});

test("OWN measures concentration, not just who holds it", async ({ page }) => {
  await open(page, "OWN");
  await expect(page.getByText(/Top 5 holders own/)).toBeVisible({ timeout: 45_000 });
  // 6.4 + 3.2 + 2.1 + 1.7 + 1.4 = 14.8%. .first(): the card and the summary
  // sentence both carry it, which is deliberate.
  await expect(page.getByText("14.8%").first()).toBeVisible();
  await expect(page.getByText(/Largest single stake/)).toBeVisible();
});

test("OWN says the stakes do not sum to 100 and that filings lag", async ({ page }) => {
  await open(page, "OWN");
  await expect(page.getByText(/do not sum to 100%/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/filings lag/)).toBeVisible();
});

test("DES reports performance over real calendar windows", async ({ page }) => {
  await open(page, "DES");
  await expect(page.getByText("Performance")).toBeVisible({ timeout: 45_000 });
  for (const h of ["1 week", "1 month", "1 year", "Year to date"]) {
    await expect(page.getByText(h, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/Worst drawdown/)).toBeVisible();
});

test("DES states the window and that returns exclude dividends", async ({ page }) => {
  await open(page, "DES");
  await expect(page.getByText(/sessions,/).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/dividends are not added back/)).toBeVisible();
});
