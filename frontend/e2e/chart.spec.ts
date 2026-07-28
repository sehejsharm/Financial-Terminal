import { expect, test } from "@playwright/test";

import { ADMIN_PASS, ADMIN_USER, BOUNDARY_TEXT } from "./helpers";

/**
 * Chart indicators, driven by a STUBBED price feed.
 *
 * The providers are unreachable from CI, so without stubbing, the terminal
 * never leaves its loading state and the chart is never mounted — meaning the
 * indicator code would go completely unexercised end-to-end. Here the history
 * and snapshot endpoints are intercepted with a synthetic series, so every
 * overlay and sub-pane is actually rendered by the real charting library.
 */

let tokenPromise: Promise<string> | null = null;

/** 260 deterministic daily bars — a drifting random-ish walk with volume. */
function bars() {
  const out: any[] = [];
  let px = 100;
  for (let i = 0; i < 260; i++) {
    // Deterministic wobble; no Math.random so the test can't flake.
    const d = Math.sin(i / 7) * 1.5 + Math.cos(i / 23) * 2 + 0.05;
    px = Math.max(5, px + d);
    const high = px + 1.2, low = px - 1.1;
    out.push({
      time: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      open: px - d, high, low, close: px, volume: 100000 + (i % 17) * 5000,
    });
  }
  return out;
}

test.beforeEach(async ({ page }) => {
  tokenPromise ??= page.request
    .post("http://localhost:8000/api/v1/auth/login", {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
    })
    .then(async (res) => {
      if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
      return (await res.json()).access_token as string;
    });
  await page.context().addCookies([{
    name: "mb_token", value: await tokenPromise,
    url: "http://localhost:3000", sameSite: "Lax",
  }]);

  await page.route("**/api/v1/market/history/**", (r) =>
    r.fulfill({ json: { ticker: "TEST", period: "1Y", candles: bars() } }));
  await page.route("**/api/v1/market/snapshot/**", (r) =>
    r.fulfill({ json: {
      symbol: "TEST", name: "Test Corp", sector: "Technology",
      industry: "Software", price: 180, prev_close: 179, currency: "INR",
      market_cap: 5.2e12, trailing_pe: 24, forward_pe: 21, beta: 1.1,
      fifty_two_high: 210, fifty_two_low: 120,
      fifty_day_avg: 175, two_hundred_day_avg: 160,
      volume: 1.2e6, avg_volume: 9e5, eps_trailing: 7.4,
    } }));
  await page.route("**/api/v1/market/quote/**", (r) =>
    r.fulfill({ json: {
      symbol: "TEST", price: 180, prev_close: 179, change_pct: 0.56,
      currency: "INR",
    } }));

  await page.goto("/terminal?t=TEST.NS&fn=GIP");
  await expect(page.getByRole("button", { name: "CANDLES" })).toBeVisible();
});

const overlays = ["SMA10", "SMA20", "SMA50", "SMA100", "SMA200",
                  "EMA9", "EMA21", "EMA50",
                  "BOLL", "DONCH", "KELT", "PSAR", "SUPER", "ICHI", "VWAP"];
const panes = ["RSI", "MACD", "STOCH", "ATR", "ADX", "OBV", "CCI", "%R", "MFI", "ROC"];

test("every overlay and sub-pane is on the toolbar", async ({ page }) => {
  for (const o of overlays) {
    await expect(page.getByRole("button", { name: o, exact: true }),
                 `overlay ${o}`).toBeVisible();
  }
  for (const p of panes) {
    await expect(page.getByRole("button", { name: p, exact: true }),
                 `pane ${p}`).toBeVisible();
  }
});

test("EVERY overlay renders without crashing the chart", async ({ page }) => {
  for (const o of overlays) {
    await page.getByRole("button", { name: o, exact: true }).click();
    await expect(page.getByText(BOUNDARY_TEXT), `overlay ${o} crashed`).toHaveCount(0);
  }
  // All 15 on at once — the stress case.
  await expect(page.getByRole("button", { name: "CLEAR", exact: true })).toBeVisible();
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});

test("EVERY sub-pane renders without crashing the chart", async ({ page }) => {
  for (const p of panes) {
    await page.getByRole("button", { name: p, exact: true }).click();
    await expect(page.getByText(BOUNDARY_TEXT), `pane ${p} crashed`).toHaveCount(0);
    // Toggling it off again must be equally safe.
    await page.getByRole("button", { name: p, exact: true }).click();
    await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
  }
});

test("CLEAR removes every overlay", async ({ page }) => {
  await page.getByRole("button", { name: "SMA20", exact: true }).click();
  await page.getByRole("button", { name: "BOLL", exact: true }).click();
  await page.getByRole("button", { name: "CLEAR", exact: true }).click();
  await expect(page.getByRole("button", { name: "CLEAR", exact: true })).toHaveCount(0);
});

test("overlay choices survive a reload", async ({ page }) => {
  await page.getByRole("button", { name: "SMA50", exact: true }).click();
  await page.getByRole("button", { name: "VWAP", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "SMA50", exact: true }))
    .toHaveClass(/text-amber/);
  await expect(page.getByRole("button", { name: "VWAP", exact: true }))
    .toHaveClass(/text-amber/);
});

test("chart type and scale toggles work alongside indicators", async ({ page }) => {
  await page.getByRole("button", { name: "ADX", exact: true }).click();
  await page.getByRole("button", { name: "CANDLES", exact: true }).click();
  await page.getByRole("button", { name: "LOG", exact: true }).click();
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});
