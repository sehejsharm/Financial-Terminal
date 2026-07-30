import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * SHARKS' reading of bulk, block and insider activity.
 *
 * Three tables of raw disclosure rows, none of them read. Two of the missing
 * readings matter a lot: the participant count sat in a column doing nothing
 * (one desk's decision rendered identically to a dozen desks agreeing), and
 * insider rows lumped ESOP allotments in with open-market buys, which
 * manufactures an "insiders are buying" signal out of payroll.
 */

const AGG = {
  from: "2026-06-01", to: "2026-06-30", note: null,
  rows: [
    // Big net value, but buying and selling cancel: a transfer, not a signal.
    { symbol: "BALANCED", deals: 20, participants: 8,
      buy_qty: 1_000_000, sell_qty: 990_000, net_qty: 10_000,
      buy_value: 5e10, sell_value: 4.95e10, net_value: 5e8 },
    // Genuinely one-sided, but a single participant.
    { symbol: "SOLO", deals: 2, participants: 1,
      buy_qty: 800_000, sell_qty: 50_000, net_qty: 750_000,
      buy_value: 4e9, sell_value: 2.5e8, net_value: 3.75e9 },
    // Genuinely one-sided across many participants.
    { symbol: "BROAD", deals: 18, participants: 11,
      buy_qty: 900_000, sell_qty: 60_000, net_qty: 840_000,
      buy_value: 4.5e9, sell_value: 3e8, net_value: 4.2e9 },
  ],
};

const INSIDERS = {
  note: null,
  rows: [
    { symbol: "RELIANCE", person: "A Promoter", category: "Promoter",
      type: "Market purchase", qty: 10_000, value: 1.4e7, date: "2026-06-20" },
    { symbol: "TCS", person: "An Officer", category: "KMP",
      type: "Sale", qty: 5_000, value: 1.8e7, date: "2026-06-19" },
    { symbol: "INFY", person: "An Employee", category: "KMP",
      type: "ESOP allotment", qty: 20_000, value: 3.1e7, date: "2026-06-18" },
    { symbol: "WIPRO", person: "A Promoter", category: "Promoter",
      type: "Pledge creation", qty: 1_000_000, value: null, date: "2026-06-17" },
  ],
};

const DEALS = [
  { symbol: "RELIANCE", client_name: "Some Fund", deal_type: "BUY",
    qty: 1_200_000, avg_price: 1425.6, date: "2026-06-30" },
];

async function open(page: Page, tab?: string) {
  await login(page);
  await page.route("**/api/v1/deals/aggregate**", (r) => r.fulfill({ json: AGG }));
  await page.route("**/api/v1/deals/insider**", (r) => r.fulfill({ json: INSIDERS }));
  await page.route("**/api/v1/deals/bulk**", (r) => r.fulfill({ json: DEALS }));
  await page.route("**/api/v1/deals/block**", (r) => r.fulfill({ json: DEALS }));
  await page.goto("/sharks");
  if (tab) await page.getByRole("button", { name: tab }).click();
}

test("SHARKS separates a single desk's decision from a dozen agreeing", async ({ page }) => {
  await open(page);
  // The label and its wrapper both match, so take the first.
  await expect(page.getByText("Genuinely one-sided").first())
    .toBeVisible({ timeout: 60_000 });
  // The card's read and the summary note both say this, deliberately.
  await expect(page.getByText(/SINGLE participant/).first()).toBeVisible();
  await expect(page.getByText(/not a consensus/)).toBeVisible();
  await expect(page.getByText(/independent agreement/)).toBeVisible();
});

test("SHARKS keeps a name whose two sides cancel out of the highlights", async ({ page }) => {
  // A ₹500cr name that nets to zero is a large transfer, not a large signal,
  // and by net value alone it would sit at the top.
  await open(page);
  // The label and its wrapper both match, so take the first.
  await expect(page.getByText("Genuinely one-sided").first())
    .toBeVisible({ timeout: 60_000 });
  const cards = page.locator(".hud").filter({ hasText: /participant/ });
  await expect(cards.filter({ hasText: "BALANCED" })).toHaveCount(0);
  await expect(cards.filter({ hasText: "SOLO" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "BROAD" })).toHaveCount(1);
});

test("SHARKS shows net skew, because net quantity alone can't tell", async ({ page }) => {
  await open(page);
  const table = page.locator("table").first();
  await expect(table).toBeVisible({ timeout: 60_000 });
  await expect(table.getByRole("columnheader", { name: /Net skew/ })).toBeVisible();
});

test("SHARKS says disclosure is a SIZE threshold, not conviction", async ({ page }) => {
  await open(page);
  await expect(page.getByText(/a SIZE threshold, not a conviction one/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/price has already moved by the time you read it/))
    .toBeVisible();
});

test("SHARKS counts ESOP allotments apart from open-market buys", async ({ page }) => {
  // Folding a grant into the buy count manufactures conviction out of payroll.
  await open(page, "Insider (PIT)");
  await expect(page.getByText("Open-market buys").first())
    .toBeVisible({ timeout: 60_000 });
  const table = page.getByTestId("insider-table");
  // exact, or this also matches the raw "ESOP allotment" type cell.
  await expect(table.getByRole("cell", { name: "allotment", exact: true }))
    .toBeVisible();
  await expect(table.getByRole("cell", { name: "open-market buy", exact: true }))
    .toBeVisible();
  await expect(page.getByText(/compensation being issued/)).toBeVisible();
  await expect(page.getByText(/out of payroll/)).toBeVisible();
});

test("SHARKS treats a pledge as neither a buy nor a sell", async ({ page }) => {
  await open(page, "Insider (PIT)");
  await expect(page.getByText("Pledge-related").first())
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/promoter borrowing against stock/)).toBeVisible();
  await expect(page.getByText(/rather than their view of the company/)).toBeVisible();
});

test("SHARKS says insider sales carry less information than buys", async ({ page }) => {
  await open(page, "Insider (PIT)");
  await expect(page.getByText(/sales carry much less information than buys/))
    .toBeVisible({ timeout: 60_000 });
});

test("SHARKS explains what a bulk deal is on the raw table", async ({ page }) => {
  await open(page, "Bulk deals");
  await expect(page.getByText(/above 0\.5% of a company's listed shares/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/a record of who moved, not a trade to follow/))
    .toBeVisible();
});

test("SHARKS explains that a block deal is a different thing", async ({ page }) => {
  await open(page, "Block deals");
  await expect(page.getByText(/single negotiated trade of at least ₹10 crore/))
    .toBeVisible({ timeout: 60_000 });
});

test("SHARKS labels the deal columns instead of database keys", async ({ page }) => {
  await open(page, "Bulk deals");
  const table = page.locator("table").first();
  await expect(table).toBeVisible({ timeout: 60_000 });
  await expect(table.getByRole("columnheader", { name: /Client/ })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: /client_name/ })).toHaveCount(0);
});
