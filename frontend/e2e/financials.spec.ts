import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * FA — the financials screens.
 *
 * Statements are stubbed (the free providers don't cover Indian listings and
 * aren't reachable from CI anyway) with a business whose numbers deteriorate
 * in two specific, checkable ways: cash conversion falling and gross margin
 * compressing. The screen has to find both.
 */

const YEARS = ["2025-03-31", "2024-03-31", "2023-03-31", "2022-03-31"];
const mk = (rows: Record<string, number[]>) => ({
  columns: YEARS, source: "FMP",
  rows: Object.entries(rows).map(([line, v]) => ({
    line, ...Object.fromEntries(YEARS.map((c, i) => [c, v[i]])),
  })),
});

// Newest column first, matching the provider convention.
const INCOME = mk({
  Revenue: [9740e7, 8920e7, 7920e7, 6980e7],
  "Cost of Revenue": [6100e7, 5480e7, 4790e7, 4130e7],
  "Gross Profit": [3640e7, 3440e7, 3130e7, 2850e7],
  "Operating Income": [1660e7, 1610e7, 1480e7, 1360e7],
  EBITDA: [2100e7, 2020e7, 1850e7, 1690e7],
  "Pre-Tax Income": [1510e7, 1490e7, 1390e7, 1290e7],
  "Tax Provision": [380e7, 375e7, 350e7, 325e7],
  "Net Income": [1130e7, 1115e7, 1040e7, 965e7],
  // Rising EPS on near-flat income: the count is shrinking.
  "EPS (diluted)": [17.4, 16.6, 15.1, 13.6],
});
const BALANCE = mk({
  "Total Assets": [17800e7, 16200e7, 14900e7, 13600e7],
  "Total Current Assets": [6900e7, 6100e7, 5600e7, 5100e7],
  Inventory: [1950e7, 1780e7, 1610e7, 1480e7],
  "Cash & Equivalents": [1420e7, 1180e7, 980e7, 860e7],
  "Total Current Liabilities": [5400e7, 4900e7, 4500e7, 4100e7],
  "Total Debt": [4900e7, 4200e7, 3600e7, 3100e7],
  "Shareholders' Equity": [8200e7, 7400e7, 6800e7, 6200e7],
});
const CASHFLOW = mk({
  "Operating Cash Flow": [1480e7, 1520e7, 1460e7, 1390e7],
  "Capital Expenditure": [-980e7, -860e7, -740e7, -690e7],
  "Free Cash Flow": [500e7, 660e7, 720e7, 700e7],
});

// Five quarters: four beats, one miss, ending on a two-beat run.
const EARNINGS = {
  columns: ["quarter", "epsActual", "epsEstimate"],
  rows: [
    { quarter: "2024-06-30", epsActual: 4.10, epsEstimate: 4.00 },
    { quarter: "2024-09-30", epsActual: 4.35, epsEstimate: 4.20 },
    { quarter: "2024-12-31", epsActual: 4.05, epsEstimate: 4.30 },
    { quarter: "2025-03-31", epsActual: 4.62, epsEstimate: 4.40 },
    { quarter: "2025-06-30", epsActual: 4.75, epsEstimate: 4.55 },
  ],
};

const ESTIMATES = {
  price_targets: {
    low: 1180, mean: 1620, median: 1600, high: 2100, current: 1425.6,
  },
  earnings_estimate: { "0q": { avg: 4.8, low: 4.4, high: 5.2 } },
};

async function openFa(page: Page, fn = "FA") {
  await login(page);
  await page.route("**/statement/income**", (r) =>
    r.fulfill({ json: { ticker: "RELIANCE.NS", kind: "income", ...INCOME } }));
  await page.route("**/statement/balance**", (r) =>
    r.fulfill({ json: { ticker: "RELIANCE.NS", kind: "balance", ...BALANCE } }));
  await page.route("**/statement/cashflow**", (r) =>
    r.fulfill({ json: { ticker: "RELIANCE.NS", kind: "cashflow", ...CASHFLOW } }));
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({ json: {
    name: "Reliance Industries Ltd", sector: "Energy", price: 1425.6,
    currency: "INR", current_ratio: 1.28,
  } }));
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({ json: {
    symbol: "RELIANCE.NS", price: 1425.6, prev_close: 1440.2, change_pct: -1.01 } }));
  await page.route("**/capital-structure**", (r) => r.fulfill({ json: {
    total_debt: 3.24e12, cash: 1.12e12, market_cap: 19.3e12, shares: 6.77e9,
    currency: "INR" } }));
  await page.route("**/earnings-history**", (r) => r.fulfill({ json: EARNINGS }));
  await page.route("**/estimates**", (r) => r.fulfill({ json: ESTIMATES }));
  await page.goto(`/terminal?t=RELIANCE.NS&fn=${fn}`);
}

test("FA offers statements, ratios and quality — not just a data dump", async ({ page }) => {
  await openFa(page);
  for (const t of ["Income", "Balance sheet", "Cash flow", "Ratios", "Quality"]) {
    await expect(page.getByRole("tab", { name: new RegExp(`^${t}`) }))
      .toBeVisible({ timeout: 45_000 });
  }
});

test("periods run oldest to newest, whatever order the provider sent", async ({ page }) => {
  // Providers send newest-first. A growth rate computed over a reversed
  // series has the right magnitude and the wrong sign.
  await openFa(page);
  const heads = page.locator("thead th");
  await expect(heads.filter({ hasText: "2022-03-31" })).toBeVisible({ timeout: 45_000 });
  const all = await heads.allTextContents();
  const years = all.filter((t) => /^\d{4}-/.test(t.trim()));
  expect(years).toEqual([...years].sort());
});

test("the ratio sheet prints each formula next to its number", async ({ page }) => {
  await openFa(page);
  await expect(page.getByRole("tab", { name: "Ratios" }))
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("tab", { name: "Ratios" }).click();
  await expect(page.getByText("gross profit / revenue")).toBeVisible();
  await expect(page.getByText("net income / shareholders' equity")).toBeVisible();
  await expect(page.getByText("(total debt − cash) / EBITDA")).toBeVisible();
});

test("quality flags the two things wrong with this business", async ({ page }) => {
  await openFa(page);
  await expect(page.getByRole("tab", { name: /^Quality/ }))
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("tab", { name: /^Quality/ }).click();
  await expect(page.getByText(/not converting into cash/i)).toBeVisible();
  await expect(page.getByText(/Gross margin is compressing/i)).toBeVisible();
  // And it names what to check rather than just asserting a problem.
  await expect(page.getByText(/capex and working capital/i)).toBeVisible();
});

test("the tab badge counts the flags so they aren't missed", async ({ page }) => {
  await openFa(page);
  await expect(page.getByRole("tab", { name: /^Quality/ })).toContainText("2");
});

test("common-size recomputes every line against revenue", async ({ page }) => {
  await openFa(page);
  await expect(page.getByRole("cell", { name: /Revenue/ }).first())
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "% of revenue" }).click();
  // Revenue against itself is 100% in every period.
  await expect(page.getByRole("cell", { name: "100.0%" }).first()).toBeVisible();
});

test("growth mode signs each change", async ({ page }) => {
  await openFa(page);
  // Wait for the statement to be on screen before switching mode: the panel
  // is gated on the quote resolving, and clicking into an empty table then
  // asserting on its contents is a race, not a test.
  await expect(page.getByText(/4 periods common to 3 statements/))
    .toBeVisible({ timeout: 45_000 });
  // By its title: "Growth" alone also matches a growth-estimates control
  // elsewhere on the page.
  await page.getByRole("button", { name: "Growth", exact: true })
    .and(page.locator('[title="Period on period"]')).click();
  await expect(page.getByText(/^\+\d+\.\d%$/).first())
    .toBeVisible({ timeout: 20_000 });
});

test("the header says how many periods the ratios actually span", async ({ page }) => {
  await openFa(page);
  await expect(page.getByText(/4 periods common to 3 statements/))
    .toBeVisible({ timeout: 45_000 });
});

test("DDIS shows the leverage trend, not just today's number", async ({ page }) => {
  await openFa(page, "DDIS");
  // .first(): the caveat below the cards names the same metric, which is
  // deliberate — the assumption belongs next to the number AND in the note.
  await expect(page.getByText(/Years of FCF to clear net debt/i).first())
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/How it has moved/i)).toBeVisible();
  await expect(page.getByText(/no maturity ladder/i)).toBeVisible();
});


test("CS values the whole enterprise, not just the equity", async ({ page }) => {
  await openFa(page, "CS");
  await expect(page.getByText(/Enterprise value/).first())
    .toBeVisible({ timeout: 45_000 });
  for (const m of [/EV \/ EBITDA/, /EV \/ sales/, /EV \/ free cash flow/]) {
    await expect(page.getByText(m)).toBeVisible();
  }
});

test("CS derives the share count and says whether it is rising", async ({ page }) => {
  // Net income and diluted EPS recover the count exactly. A company buying
  // back 3% a year and one issuing 3% look identical on a debt/equity bar.
  await openFa(page, "CS");
  await expect(page.getByText(/Implied diluted shares/))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Change per year/)).toBeVisible();
  await expect(page.getByText(/derived/).first()).toBeVisible();
});

test("ERN reports the record, not just the last quarter", async ({ page }) => {
  await openFa(page, "ERN");
  await expect(page.getByText(/Hit rate/)).toBeVisible({ timeout: 45_000 });
  // .first(): the card and the summary sentence both say it.
  await expect(page.getByText("80%").first()).toBeVisible();   // 4 of 5
  await expect(page.getByText(/Typical surprise/)).toBeVisible();
  await expect(page.getByText("4B / 1M")).toBeVisible();
  await expect(page.getByText(/Current beat streak/)).toBeVisible();
});

test("ERN says what a high hit rate actually means", async ({ page }) => {
  await openFa(page, "ERN");
  await expect(page.getByText(/guides\s+conservatively/i))
    .toBeVisible({ timeout: 45_000 });
});

test("EE shows the upside and the spread, not just the target", async ({ page }) => {
  // A target of 1,620 means nothing until you know the price is 1,425.60,
  // and a tight band and a 57%-wide one carry the same mean.
  await openFa(page, "EE");
  await expect(page.getByText(/Implied upside to mean/))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("+13.6%")).toBeVisible();
  await expect(page.getByText(/Spread of views/)).toBeVisible();
  await expect(page.getByText(/targets follow the share more often/i)).toBeVisible();
});
