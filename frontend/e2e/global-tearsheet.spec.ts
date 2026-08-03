import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * GLOBAL's board summary and the TEAR SHEET's provenance.
 *
 * Global rendered forty tinted tiles and no synthesis, and had no idea how much
 * of itself was working — a board with half its tiles unpriced looks remarkably
 * like a calm market.
 *
 * The tear sheet stamped "as of <now>" from the browser clock at render, which
 * on a printed page is indistinguishable from a live quote, and ran String()
 * over comps values so a market cap printed as seventeen digits.
 */

test.setTimeout(120_000);

// ── GLOBAL ────────────────────────────────────────────────────────────────

test("GLOBAL counts what the board adds up to", async ({ page }) => {
  await login(page);
  await page.goto("/global");
  await expect(page.getByText("What the board adds up to"))
    .toBeVisible({ timeout: 60_000 });
  for (const label of ["Advancing", "Declining", "Unpriced", "Average move"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
});

test("GLOBAL reports unpriced tiles rather than footnoting them", async ({ page }) => {
  // Providers are blocked from this environment, so essentially nothing
  // prices — which is exactly the case the count exists to make visible.
  await login(page);
  await page.goto("/global");
  await expect(page.getByText(/priced/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/looks very like a quiet one|too little to characterise the tape/))
    .toBeVisible();
});

test("GLOBAL withholds a risk read it cannot support", async ({ page }) => {
  // Under 60% coverage the tone is not guessed at.
  await login(page);
  await page.goto("/global");
  await expect(page.getByText(/too little to characterise the tape/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/looks very like a calm market/)).toBeVisible();
});

test("GLOBAL says why commodities are out of the risk read", async ({ page }) => {
  await login(page);
  await page.goto("/global");
  await expect(page.getByText(/risk-on in a demand story and risk-off in a supply shock/))
    .toBeVisible({ timeout: 60_000 });
});

test("GLOBAL says different sessions aren't measuring the same period", async ({ page }) => {
  await login(page);
  await page.goto("/global");
  await expect(page.getByText(/not measuring the same period/))
    .toBeVisible({ timeout: 60_000 });
});

// ── TEAR SHEET ────────────────────────────────────────────────────────────

const SNAP = {
  name: "Reliance Industries Ltd", sector: "Energy", industry: "Refining",
  price: 1425.6, currency: "INR", market_cap: 19.3e12, trailing_pe: 27.1,
  beta: 1.15, dividend_yield: 0.0035, roe: 0.091, profit_margin: 0.081,
  debt_to_equity: 36.65, fifty_two_high: 1608, fifty_two_low: 1114,
};

const COMPS = [
  { ticker: "RELIANCE.NS", name: "Reliance Industries", market_cap: 19.3e12,
    trailing_pe: 27.1, roe: 0.091 },
  { ticker: "ONGC.NS", name: "ONGC", market_cap: 3.1e12,
    trailing_pe: 8.4, roe: 0.152 },
];

async function openSheet(page: Page, comps: unknown[] = COMPS, snap = SNAP) {
  await login(page);
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({ json: snap }));
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({ json: {
    symbol: "RELIANCE.NS", price: 1425.6, change_pct: -1.01, currency: "INR" } }));
  await page.route("**/fundamentals/**/peers**", (r) => r.fulfill({ json: {
    peers: ["RELIANCE.NS", "ONGC.NS"], sector: "Energy", basis: "sector", market: "NSE" } }));
  await page.route("**/fundamentals/comps**", (r) => r.fulfill({ json: comps }));
  await page.route("**/api/v1/notes/**", (r) => r.fulfill({ json: {
    ticker: "RELIANCE.NS", text: "", updated_at: null } }));
  await page.goto("/tearsheet?t=RELIANCE.NS");
}

test("TEAR SHEET humanises comps instead of printing seventeen digits", async ({ page }) => {
  await openSheet(page);
  const comps = page.getByTestId("comps");
  await expect(comps).toBeVisible({ timeout: 60_000 });
  await expect(comps.getByRole("cell", { name: "₹19.30T" })).toBeVisible();
  await expect(comps.getByRole("cell", { name: "9.1%" })).toBeVisible();
  // The raw magnitude must never reach the page.
  await expect(page.getByText("19300000000000")).toHaveCount(0);
});

test("TEAR SHEET labels comps columns instead of database keys", async ({ page }) => {
  await openSheet(page);
  const comps = page.getByTestId("comps");
  await expect(comps.getByRole("columnheader", { name: "Market cap" }))
    .toBeVisible({ timeout: 60_000 });
  await expect(comps.getByRole("columnheader", { name: "P/E" })).toBeVisible();
  await expect(comps.getByRole("columnheader", { name: "trailing_pe" })).toHaveCount(0);
});

test("TEAR SHEET marks which comps row is the subject", async ({ page }) => {
  await openSheet(page);
  const comps = page.getByTestId("comps");
  await expect(comps).toBeVisible({ timeout: 60_000 });
  const subject = comps.locator("tr").filter({ hasText: "RELIANCE.NS" });
  await expect(subject).toHaveClass(/text-amber/);
});

test("TEAR SHEET REFUSES to let the print time read as the data time", async ({ page }) => {
  // "as of <now>" from the render clock is indistinguishable from a live quote
  // once the page is on paper.
  await openSheet(page);
  await expect(page.getByText(/Printed \d{4}-\d{2}-\d{2}/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/NOT a quote at the printed time/)).toBeVisible();
  await expect(page.getByText(/a printed sheet never refreshes/)).toBeVisible();
  await expect(page.getByText(/as of \d/)).toHaveCount(0);
});

test("TEAR SHEET says a blank is a coverage gap, not a zero", async ({ page }) => {
  await openSheet(page, COMPS, { ...SNAP, roe: null, beta: null });
  await expect(page.getByText(/6 of 8 header metrics populated/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/not a zero and not a company that lacks the figure/))
    .toBeVisible();
});

test("TEAR SHEET stays quiet about coverage when everything populated", async ({ page }) => {
  await openSheet(page);
  await expect(page.getByText(/Printed \d{4}/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/header metrics populated/)).toHaveCount(0);
});
