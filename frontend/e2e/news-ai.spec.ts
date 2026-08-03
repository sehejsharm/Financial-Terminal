import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * CN (a ticker's news) and AI (the deep-dive).
 *
 * Both screens were hiding the work that makes them trustworthy. CN discarded
 * the entity filter's own report — the fix for RELIANCE.NS returning news about
 * Reliance Steel — so a reader with four headlines couldn't tell whether the
 * company was quiet or twelve namesake stories had been filtered out. AI
 * printed a confident narrative with no way to check it against its inputs.
 */

const ITEMS = [
  { title: "Reliance Industries posts record quarter", publisher: "Mint",
    link: "https://example.com/1", summary: "Refining margins expanded.",
    published: new Date(Date.now() - 3_600_000).toISOString(),
    source: "Mint", match: "exact" },
  { title: "Reliance Jio adds 3m subscribers", publisher: "Economic Times",
    link: "https://example.com/2", summary: "Subscriber growth continued.",
    published: new Date(Date.now() - 7_200_000).toISOString(),
    source: "Economic Times", match: "name" },
];

const FEED = {
  ticker: "RELIANCE.NS", items: ITEMS,
  entity: "Reliance Industries Ltd", matched: 2, dropped: 9, strict: true,
};

const SENTIMENT = {
  ticker: "RELIANCE.NS", score: 0.5,
  // Note the curly apostrophe and the extra spaces: a tag keyed by raw title
  // would fail to line up, and the story would silently render untagged.
  items: [
    { title: "Reliance Industries  posts record quarter", sentiment: "bull" },
    { title: "Reliance Jio adds 3m subscribers", sentiment: "neutral" },
  ],
  history: [{ ts: "2026-06-01T00:00:00Z", ticker: "RELIANCE.NS", score: 0.2, n: 5 },
            { ts: "2026-06-02T00:00:00Z", ticker: "RELIANCE.NS", score: 0.5, n: 6 }],
};

const AI_RESP = {
  ticker: "RELIANCE.NS",
  markdown: "## Bull case\n\nRefining margins are expanding.\n\n## Bear case\n\nCapex is heavy.",
  // Deliberately partial: no profit margin, no ROE, no free cash flow.
  inputs: {
    market_cap: "₹17.77T", trailing_pe: 27.12, revenue: "₹9.74T",
    debt_to_equity: "0.37x", revenue_growth: "9.20%", beta: 1.15,
  },
  generated_at: new Date().toISOString(),
  provider: "groq",
};

async function open(page: Page, fn: string, opts: { strictFeed?: unknown } = {}) {
  await login(page);
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({ json: {
    name: "Reliance Industries Ltd", sector: "Energy", price: 1425.6, currency: "INR",
  } }));
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({ json: {
    symbol: "RELIANCE.NS", price: 1425.6, prev_close: 1440.2, change_pct: -1.01 } }));
  await page.route("**/api/v1/market/news/**", (r) => {
    const strict = !r.request().url().includes("strict=false");
    r.fulfill({ json: strict
      ? (opts.strictFeed ?? FEED)
      : { ...FEED, strict: false, dropped: null, matched: null,
          items: [...ITEMS, {
            title: "Reliance Steel reports lower shipments", publisher: "Reuters",
            link: "https://example.com/3", summary: "US metals distributor.",
            published: new Date().toISOString(), source: "Reuters", match: "weak" }] } });
  });
  await page.route("**/api/v1/ai/provider", (r) =>
    r.fulfill({ json: { available: true, provider: "groq" } }));
  await page.route("**/api/v1/ai/sentiment", (r) => r.fulfill({ json: SENTIMENT }));
  await page.route("**/api/v1/ai/bull-bear", (r) => r.fulfill({ json: AI_RESP }));
  await page.route("**/api/v1/ai/deep-analysis", (r) => r.fulfill({ json: AI_RESP }));
  await page.goto(`/terminal?t=RELIANCE.NS&fn=${fn}`);
}

// ── CN ────────────────────────────────────────────────────────────────────

/** The filter's own account now lives behind a disclosure — it belongs on the
 *  page, just not stacked above the headlines. */
async function openHow(page: Page) {
  await page.getByText("How these headlines were chosen").click();
}

test("CN says how many namesake stories the filter removed", async ({ page }) => {
  // Without this, a short list looks the same whether the company is quiet or
  // the matching is broken — which makes the filter's failures unfalsifiable.
  await open(page, "CN");
  // The count itself stays visible at a glance; the explanation folds away.
  await expect(page.getByText(/9 namesakes filtered out/))
    .toBeVisible({ timeout: 45_000 });
  await openHow(page);
  await expect(page.getByText(/9 stories were dropped as being about a different company/))
    .toBeVisible();
});

test("CN names the entity it filtered against and how a story qualifies", async ({ page }) => {
  await open(page, "CN");
  await expect(page.getByText(/News — Reliance Industries Ltd/))
    .toBeVisible({ timeout: 45_000 });
  await openHow(page);
  await expect(page.getByText(/exchange-qualified symbol, an ISIN, or every distinctive word/))
    .toBeVisible();
  // And admits the filter can exclude a genuine story.
  await expect(page.getByText(/errs towards excluding/)).toBeVisible();
});

test("CN can show the raw feed, which is the only way to check the filter", async ({ page }) => {
  await open(page, "CN");
  await expect(page.getByRole("button", { name: "This company only" }))
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "This company only" }).click();
  await openHow(page);
  await expect(page.getByText(/Entity filtering is OFF/)).toBeVisible();
  // The namesake that strict mode excluded is now on screen, marked loose.
  await expect(page.getByText(/Reliance Steel reports lower shipments/)).toBeVisible();
  await expect(page.getByText("loose", { exact: true }).first()).toBeVisible();
});

test("CN matches sentiment tags despite cosmetic title differences", async ({ page }) => {
  // The fixture's tag has a doubled space the feed title doesn't. Keying on the
  // raw string loses the tag, and a lost tag renders as an untagged story
  // rather than as an error.
  await open(page, "CN");
  await expect(page.getByRole("button", { name: /Analyze sentiment/ }))
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /Analyze sentiment/ }).click();
  await expect(page.getByText("bull", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Sentiment \+/)).toBeVisible();
});

test("CN says a sentiment score reads tone, not importance", async ({ page }) => {
  await open(page, "CN");
  await page.getByRole("button", { name: /Analyze sentiment/ }).click();
  await expect(page.getByText(/Sentiment \+/)).toBeVisible({ timeout: 45_000 });
  await openHow(page);
  await expect(page.getByText(/reads TONE, not importance/)).toBeVisible();
  await expect(page.getByText(/the fall being reported rather than a signal/))
    .toBeVisible();
});

test("CN explains an empty filtered list rather than looking broken", async ({ page }) => {
  await open(page, "CN", {
    strictFeed: { ticker: "RELIANCE.NS", items: [],
                  entity: "Reliance Industries Ltd", matched: 0, dropped: 11,
                  strict: true } });
  await expect(page.getByText(/No headlines matched Reliance Industries Ltd/))
    .toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/none of them were about this/)).toBeVisible();
});

// ── AI ────────────────────────────────────────────────────────────────────

test("AI shows the figures the model was actually given", async ({ page }) => {
  await open(page, "AI");
  await expect(page.getByRole("button", { name: "Bull vs Bear" }))
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Bull vs Bear" }).click();
  await expect(page.getByText("Refining margins are expanding.")).toBeVisible();
  await expect(page.getByText("What the model was given")).toBeVisible();
  await page.getByRole("button", { name: "Show figures" }).click();
  // "Market cap" also labels a header stat, so scope to the figure's own row.
  await expect(page.getByText("₹17.77T")).toBeVisible();
  await expect(page.getByText("P/E (trailing)")).toBeVisible();
  await expect(page.getByText("Debt / equity")).toBeVisible();
});

test("AI names the figures it did NOT have, so the prose can be discounted", async ({ page }) => {
  // A model with no margin still writes a plausible paragraph about
  // profitability. Naming the gap is the only thing that lets a reader
  // discount it.
  await open(page, "AI");
  await page.getByRole("button", { name: "Bull vs Bear" }).click();
  await expect(page.getByText("Not supplied to the model"))
    .toBeVisible({ timeout: 45_000 });
  // The caveat sentence repeats the field names, so pin the list itself.
  await expect(page.getByText("Profit margin · Return on equity · Free cash flow"))
    .toBeVisible();
  await expect(page.getByText(/will still write a paragraph about profitability/))
    .toBeVisible();
});

test("AI says a number absent from the inputs was produced, not read", async ({ page }) => {
  await open(page, "AI");
  await page.getByRole("button", { name: "Bull vs Bear" }).click();
  await expect(page.getByText(/the model produced it rather than read it/))
    .toBeVisible({ timeout: 45_000 });
});

test("AI offers a regenerate, because a disagreeing second run is information", async ({ page }) => {
  await open(page, "AI");
  await page.getByRole("button", { name: "Bull vs Bear" }).click();
  await expect(page.getByRole("button", { name: "Regenerate" }))
    .toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(page.getByText("Refining margins are expanding.")).toBeVisible();
});

test("AI keeps its provider-missing state distinct from a failed probe", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({ json: {
    name: "Reliance Industries Ltd", price: 1425.6, currency: "INR" } }));
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({ json: {
    symbol: "RELIANCE.NS", price: 1425.6, change_pct: -1.01 } }));
  await page.route("**/api/v1/ai/provider", (r) =>
    r.fulfill({ json: { available: false, provider: null } }));
  await page.goto("/terminal?t=RELIANCE.NS&fn=AI");
  await expect(page.getByText(/No AI provider configured/))
    .toBeVisible({ timeout: 45_000 });
});
