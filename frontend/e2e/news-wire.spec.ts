import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * The market wire's digest.
 *
 * The feed was already deduplicated, clustered and filterable — and it still
 * left the reader scanning a hundred and twenty lines to work out what the day
 * was about. These pin the three answers the digest adds, and the refusals
 * that keep them trustworthy: no tagging outside a fixed universe, no group
 * word pinned to one company, and a silent feed reported rather than passed
 * off as a quiet market.
 */

const hour = (h: number) =>
  new Date(Date.now() - h * 3_600_000).toISOString();

const WIRE = [
  // Three separate stories on one subject → "rate cut" becomes a theme.
  { title: "RBI holds, but keeps a rate cut on the table", publisher: "Livemint",
    link: "https://example.com/1", summary: "Policy stays on hold.",
    published: hour(1), source: "Livemint" },
  { title: "Bond market now prices a rate cut by August", publisher: "Livemint",
    link: "https://example.com/2", summary: "Yields fell.",
    published: hour(2), source: "Livemint" },
  { title: "Economists split on the timing of a rate cut", publisher: "Livemint",
    link: "https://example.com/3", summary: "Views diverge.",
    published: hour(3), source: "Livemint" },
  { title: "Reliance Industries posts a record quarter", publisher: "Economic Times",
    link: "https://example.com/4", summary: "Refining margins expanded.",
    published: hour(4), source: "Economic Times" },
  { title: "Jio adds three million subscribers", publisher: "Economic Times",
    link: "https://example.com/5", summary: "Growth continued.",
    published: hour(5), source: "Economic Times" },
  { title: "Infosys raises full-year guidance", publisher: "CNBC-TV18",
    link: "https://example.com/6", summary: "Deal wins improved.",
    published: hour(6), source: "CNBC-TV18" },
  // A group story and a false-substring trap: neither may be tagged.
  { title: "Tata group weighs a new holding structure", publisher: "Livemint",
    link: "https://example.com/7", summary: "Restructuring talk.",
    published: hour(7), source: "Livemint" },
  { title: "Titanium prices ease on weak Chinese demand", publisher: "Livemint",
    link: "https://example.com/8", summary: "Metals softened.",
    published: hour(8), source: "Livemint" },
];

async function open(page: Page, items: unknown[] = WIRE) {
  await login(page);
  // The per-ticker route must not swallow the market pull, so match exactly.
  await page.route("**/api/v1/market/news?**", (r) => r.fulfill({ json: items }));
  await page.goto("/news");
}

test("the wire says which listed companies are in the news", async ({ page }) => {
  await open(page);
  await expect(page.getByText("What the wire is saying"))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Companies in the news")).toBeVisible();
  // The headline itself is also a link, so scope to the digest's chip row.
  const chips = page.getByTestId("wire-companies");
  // Two stories name Reliance (one by the Jio alias), one names Infosys.
  const reliance = chips.getByRole("link", { name: /Reliance Industries/ });
  await expect(reliance).toBeVisible();
  await expect(reliance).toContainText("2");
  await expect(chips.getByRole("link", { name: /Infosys/ })).toBeVisible();
});

test("a company chip links straight to that name's news screen", async ({ page }) => {
  await open(page);
  const chip = page.getByTestId("wire-companies")
    .getByRole("link", { name: /Reliance Industries/ });
  await expect(chip).toBeVisible({ timeout: 45_000 });
  await expect(chip).toHaveAttribute("href", "/terminal?t=RELIANCE.NS&fn=CN");
});

test("the wire REFUSES to tag a group story or a substring match", async ({ page }) => {
  // "Tata" names half a dozen listed companies; pinning the group story to one
  // would fabricate a link. "Titanium" must not become Titan Company.
  await open(page);
  await expect(page.getByText("Companies in the news"))
    .toBeVisible({ timeout: 45_000 });
  const chips = page.getByTestId("wire-companies").locator("a");
  await expect(chips.filter({ hasText: "Titan Company" })).toHaveCount(0);
  await expect(chips.filter({ hasText: /^Tata/ })).toHaveCount(0);
  await expect(page.getByText(/Group words like “Tata” and “Adani”/)).toBeVisible();
});

test("the wire surfaces the recurring subject of the day", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Recurring subjects")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: /rate cut/ })).toBeVisible();
});

test("clicking a subject filters the feed to it", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: /rate cut/ }))
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /rate cut/ }).click();
  await expect(page.getByPlaceholder("Filter headlines…")).toHaveValue("rate cut");
  // The three rate-cut stories stay; the Infosys one goes.
  await expect(page.getByText("Infosys raises full-year guidance")).toHaveCount(0);
  await expect(page.getByText(/keeps a rate cut on the table/)).toBeVisible();
});

test("the wire reports a silent feed rather than passing it off as calm", async ({ page }) => {
  // A quiet page with sources down is indistinguishable from a quiet market.
  await open(page);
  await expect(page.getByText(/feeds silent/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/looks identical to a quiet market/)).toBeVisible();
  await expect(page.getByText("Where these came from")).toBeVisible();
});

test("the wire says its company list is fixed, so counts are a floor", async ({ page }) => {
  await open(page);
  await expect(page.getByText(/FIXED list of the NIFTY 50/))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/a floor rather than a census/)).toBeVisible();
});

test("the wire flags a feed dominated by one outlet", async ({ page }) => {
  await open(page, WIRE.map((w) => ({ ...w, source: "Livemint" })));
  await expect(page.getByText(/one outlet's editorial priorities/))
    .toBeVisible({ timeout: 45_000 });
});

test("the digest stays out of the way when there is no wire", async ({ page }) => {
  await open(page, []);
  await expect(page.getByText("What the wire is saying")).toHaveCount(0);
  await expect(page.getByText(/No headlines available right now/))
    .toBeVisible({ timeout: 45_000 });
});
