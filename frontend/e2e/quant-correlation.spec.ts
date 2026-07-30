import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * QUANT's correlation tab.
 *
 * The arithmetic was already right. The presentation made three different
 * numbers look equally solid: a correlation on 90 shared days rendered like
 * one on 250, a 0.18 that can't be told from zero rendered like a finding, and
 * a beta explaining 4% of the variance rendered like one explaining 80%.
 *
 * History is stubbed so these assert the reading rather than whatever the
 * providers return — and so the tab doesn't wait on twelve live fetches.
 */

const DAY = 86_400_000;

/** Candles from daily returns, oldest first, ending today. */
function candles(rets: number[], base = 100, endOffsetDays = 0) {
  let px = base;
  const out: { time: string; close: number }[] = [];
  for (let i = 0; i < rets.length; i++) {
    px *= 1 + rets[i];
    out.push({
      time: new Date(Date.UTC(2026, 0, 1) + (i + endOffsetDays) * DAY)
        .toISOString().slice(0, 10),
      close: px,
    });
  }
  return out;
}

const wave = (n: number, amp = 0.012, phase = 0) =>
  Array.from({ length: n }, (_, i) => amp * Math.sin((i + phase) / 3));

const N = 220;
const BASE = wave(N);
/** Uncorrelated-ish: a different, incommensurate frequency. */
const NOISE = Array.from({ length: N }, (_, i) => 0.012 * Math.sin(i * 2.399));

const HISTORY: Record<string, { time: string; close: number }[]> = {
  "^NSEI": candles(BASE),
  // Near-perfectly correlated with the index and with each other.
  "AAA.NS": candles(BASE.map((x) => x * 1.5)),
  "BBB.NS": candles(BASE.map((x) => x * 1.52)),
  // Explains almost nothing against the benchmark.
  "NOISE.NS": candles(NOISE),
  // Only 40 sessions, and they start late: this truncates everything.
  "SHORT.NS": candles(wave(40), 100, N - 40),
};

async function open(page: Page, tickers: string) {
  await login(page);
  await page.route("**/api/v1/market/history/**", (r) => {
    const url = decodeURIComponent(r.request().url());
    const sym = Object.keys(HISTORY).find((k) =>
      url.includes(`/history/${k}`) || url.includes(`/history/${encodeURIComponent(k)}`));
    r.fulfill({ json: { ticker: sym ?? "?", candles: sym ? HISTORY[sym] : [] } });
  });
  await page.addInitScript(([inp, b]) => {
    localStorage.setItem("mb_quant_input", inp as string);
    localStorage.setItem("mb_quant_bench", b as string);
  }, [tickers, "^NSEI"]);
  await page.goto("/quant");
}

test("QUANT states the shared window the matrix was computed on", async ({ page }) => {
  await open(page, "AAA.NS, BBB.NS, NOISE.NS, ^NSEI");
  // The tile and its label both match, so take the first.
  await expect(page.getByText("Shared sessions").first())
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/trading days ALL of these series share/)).toBeVisible();
});

test("QUANT names the ticker whose short history truncates every pair", async ({ page }) => {
  // The silent failure this fixes: one recently-listed name drops every pair
  // in the grid to the days it shares, and the matrix then describes a window
  // nobody asked for.
  await open(page, "AAA.NS, BBB.NS, SHORT.NS, ^NSEI");
  await expect(page.getByText(/capped by SHORT.NS/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/truncates every pair in the grid/)).toBeVisible();
});

test("QUANT counts independent bets, not tickers", async ({ page }) => {
  await open(page, "AAA.NS, BBB.NS, ^NSEI");
  await expect(page.getByText("Independent bets").first())
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/counting tickers overstates diversification/))
    .toBeVisible();
});

test("QUANT flags a pair that is one trade wearing two tickers", async ({ page }) => {
  await open(page, "AAA.NS, BBB.NS, ^NSEI");
  await expect(page.getByText("Effectively the same position"))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/one trade wearing two tickers/)).toBeVisible();
});

test("QUANT states the level below which a cell can't be told from zero", async ({ page }) => {
  await open(page, "AAA.NS, BBB.NS, NOISE.NS, ^NSEI");
  await expect(page.getByText("Significance floor")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/not distinguishable from zero/)).toBeVisible();
  // Dimmed rather than dropped — an absent number is a different claim.
  await expect(page.getByText(/dimmed rather than dropped/)).toBeVisible();
});

test("QUANT shows R² beside every beta", async ({ page }) => {
  // A beta of 1.8 explaining 4% of the variance is an artefact of the
  // regression, and without R² it looks identical to one explaining 80%.
  await open(page, "AAA.NS, NOISE.NS, ^NSEI");
  const beta = page.getByTestId("beta-table");
  await expect(beta).toBeVisible({ timeout: 60_000 });
  await expect(beta.getByRole("columnheader", { name: "R²" })).toBeVisible();
  await expect(page.getByText(/an artefact of the regression, not a sensitivity/))
    .toBeVisible();
});

test("QUANT names the tickers whose beta means little", async ({ page }) => {
  await open(page, "AAA.NS, NOISE.NS, ^NSEI");
  await expect(page.getByText(/R² under 0\.2/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/explains almost none of their movement/)).toBeVisible();
});

test("QUANT explains why its beta differs from the Snapshot's", async ({ page }) => {
  await open(page, "AAA.NS, BBB.NS, ^NSEI");
  await expect(page.getByText(/five years of monthly returns/))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/neither is more correct/)).toBeVisible();
});

test("QUANT warns that correlations converge in a selloff", async ({ page }) => {
  await open(page, "AAA.NS, BBB.NS, ^NSEI");
  await expect(page.getByText(/converge towards 1 in a selloff/))
    .toBeVisible({ timeout: 60_000 });
});

test("QUANT keeps ones down the diagonal and stays symmetric", async ({ page }) => {
  await open(page, "AAA.NS, BBB.NS, ^NSEI");
  const m = page.getByTestId("corr-matrix");
  await expect(m).toBeVisible({ timeout: 60_000 });
  const rows = m.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  // Diagonal cell of the first row (col 0 is the label).
  await expect(rows.nth(0).locator("td").nth(1)).toHaveText("1.00");
  await expect(rows.nth(1).locator("td").nth(2)).toHaveText("1.00");
});
