import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * GIP (technicals) and WACC.
 *
 * Both screens used to show raw material and leave the reading to the user —
 * GIP drew fourteen indicators without saying what any of them said, and WACC
 * printed one number from seven guesses. These tests pin the interpretation,
 * and specifically pin the refusals: the count that must not be presented as a
 * consensus, and the perpetuity that must not print an answer.
 */

// 300 sessions of a steady advance with a mid-way correction, so the trend
// reads bullish while the levels have something real to find.
const CANDLES = Array.from({ length: 300 }, (_, i) => {
  const trend = 1000 * 1.003 ** i;
  const dip = i > 150 && i < 180 ? 0.88 : 1;
  const close = trend * dip;
  return {
    time: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    open: close * 0.998, high: close * 1.012, low: close * 0.988, close,
    volume: 5_000_000 + (i % 7) * 250_000,
  };
});

const SNAPSHOT = {
  name: "Reliance Industries Ltd", sector: "Energy",
  price: CANDLES[CANDLES.length - 1].close, currency: "INR",
  market_cap: 19.3e12, beta: 1.15,
  // A fraction, as the provider sends it: 14.5% return on capital employed.
  roce: 0.145,
};

async function open(page: Page, fn: string, opts: { candles?: unknown[] } = {}) {
  await login(page);
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({ json: SNAPSHOT }));
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({ json: {
    symbol: "RELIANCE.NS", price: SNAPSHOT.price, prev_close: SNAPSHOT.price * 1.01,
    change_pct: -1.0, currency: "INR",
  } }));
  await page.route("**/api/v1/market/history/**", (r) => r.fulfill({
    json: { ticker: "RELIANCE.NS", candles: opts.candles ?? CANDLES } }));
  await page.route("**/capital-structure**", (r) => r.fulfill({ json: {
    total_debt: 3.24e12, cash: 1.12e12, market_cap: 19.3e12, shares: 6.77e9,
    currency: "INR" } }));
  await page.goto(`/terminal?t=RELIANCE.NS&fn=${fn}`);
}

// ── GIP ───────────────────────────────────────────────────────────────────

test("GIP says what each indicator reads, not just that it exists", async ({ page }) => {
  await open(page, "GIP");
  await expect(page.getByText("Indicator readout")).toBeVisible({ timeout: 45_000 });
  for (const label of ["Price vs 50-day", "Price vs 200-day", "RSI (14)",
                       "MACD vs signal", "ADX (trend strength)"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  // And groups them the way a reader thinks about them.
  for (const g of ["Trend", "Momentum", "Volatility", "Volume"]) {
    await expect(page.getByText(g, { exact: true }).first()).toBeVisible();
  }
});

test("GIP refuses to present the signal count as a consensus", async ({ page }) => {
  // The failure this prevents: "9 of 12 bullish" implies twelve independent
  // votes, when most of these are functions of the same moving averages.
  await open(page, "GIP");
  await expect(page.getByText(/That is a COUNT, not a score/))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/one observation repeated/)).toBeVisible();
  await expect(page.getByText(/they all turn late/)).toBeVisible();
});

test("GIP keeps ADX out of the direction, where it belongs", async ({ page }) => {
  await open(page, "GIP");
  await expect(page.getByText(/ADX says nothing about direction/).first())
    .toBeVisible({ timeout: 45_000 });
});

test("GIP marks up the levels either side of the price", async ({ page }) => {
  await open(page, "GIP");
  await expect(page.getByText("Key levels")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("cell", { name: /Window high/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Window low/ })).toBeVisible();
  await expect(page.getByText(/different chart period gives different levels/))
    .toBeVisible();
});

test("GIP explains a short history instead of computing off it", async ({ page }) => {
  await open(page, "GIP", { candles: CANDLES.slice(-25) });
  await expect(page.getByText(/Only 25 sessions loaded/))
    .toBeVisible({ timeout: 45_000 });
  // No fabricated 200-day average anywhere on the screen.
  await expect(page.getByText("Price vs 200-day")).toHaveCount(0);
});

// ── WACC ──────────────────────────────────────────────────────────────────

test("WACC starts from the listing's own rates, not a single global default", async ({ page }) => {
  await open(page, "WACC");
  await expect(page.getByText(/India defaults/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByLabel("Risk-free rate %")).toHaveValue("7");
});

test("WACC asks whether the business clears its cost of capital", async ({ page }) => {
  await open(page, "WACC");
  await expect(page.getByText("Does the business clear its cost of capital?"))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Return on capital employed")).toBeVisible();
  await expect(page.getByText("Spread", { exact: true })).toBeVisible();
});

test("WACC shows the range across the two unobservable assumptions", async ({ page }) => {
  await open(page, "WACC");
  await expect(page.getByText("Sensitivity")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/honest precision of this number/)).toBeVisible();
  await expect(page.getByText(/centre cell is not more true than the corners/))
    .toBeVisible();
  // A 5×5 grid plus a header row and a label column.
  await expect(page.locator("table").last().locator("tbody tr")).toHaveCount(5);
});

test("WACC re-models when an assumption changes", async ({ page }) => {
  await open(page, "WACC");
  const beta = page.getByLabel("Beta", { exact: true });
  await expect(beta).toBeVisible({ timeout: 45_000 });
  const before = await page.getByText(/^\d+\.\d\d%$/).first().textContent();
  await beta.fill("1.8");
  // A higher beta must raise the cost of equity, hence the WACC.
  await expect(page.getByText(/^\d+\.\d\d%$/).first()).not.toHaveText(before ?? "");
});

test("WACC REFUSES a terminal multiple once growth reaches the discount rate", async ({ page }) => {
  // An infinite perpetuity is a broken model, not a wonderful investment, and
  // printing a very large number invites someone to use it.
  await open(page, "WACC");
  await expect(page.getByText("What this discount rate implies"))
    .toBeVisible({ timeout: 45_000 });
  // Drive the discount rate below the growth ceiling instead of the other way
  // round: rf 0, ERP 0, beta 0 leaves the WACC on the debt side only.
  await page.getByLabel("Risk-free rate %").fill("0");
  await page.getByLabel("Equity risk premium %").fill("0");
  await page.getByLabel("Pre-tax cost of debt %").fill("0.2");
  await page.getByLabel("Beta", { exact: true }).fill("0.01");
  await page.locator('input[type="range"]').last().fill("8");
  await expect(page.getByText(/no finite value/)).toBeVisible();
  await expect(page.getByText(/broken model, not a valuation/)).toBeVisible();
});

test("WACC flags an input that cannot be true", async ({ page }) => {
  await open(page, "WACC");
  await expect(page.getByLabel("Pre-tax cost of debt %"))
    .toBeVisible({ timeout: 45_000 });
  // A company borrowing below its own government.
  await page.getByLabel("Pre-tax cost of debt %").fill("3");
  await expect(page.getByText(/No corporate borrows below its government/))
    .toBeVisible();
});
