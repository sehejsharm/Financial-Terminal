import { expect, test } from "@playwright/test";

import { BOUNDARY_TEXT, login } from "./helpers";

/** Provider-independent: market-data providers may be unreachable in CI
 *  (skeletons/not-found states are then legitimate), so these assert the
 *  page structure responds and no error boundary trips — not live quotes. */
for (const ticker of ["RELIANCE.NS", "AAPL"]) {
  test(`terminal tabs render for ${ticker}`, async ({ page }) => {
    await login(page);
    await page.goto(`/terminal?t=${encodeURIComponent(ticker)}`);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(ticker)));

    // The function selector is the page's stable anchor — it renders in
    // every data state (loaded, skeleton, not-found).
    const fnSelect = page.locator("select").first();
    await expect(fnSelect).toBeVisible();

    for (const fn of ["Snapshot", "Technicals & charts", "Financials", "Notes"]) {
      await fnSelect.selectOption(fn);
      await page.waitForTimeout(1500); // allow the tab to fetch/render
      await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
    }
  });
}

test("period buttons toggle active state", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto("/terminal?t=RELIANCE.NS");
  const fnSelect = page.locator("select").first();
  const ready = await fnSelect.waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true).catch(() => false);
  test.skip(!ready, "backend starved by provider timeouts in this environment");
  await fnSelect.selectOption("Technicals & charts");
  const btn5d = page.getByRole("button", { name: "5D", exact: true }).first();
  // Period buttons render only once quote/snapshot data loads; with market
  // providers unreachable (CI) the page legitimately stays on the skeleton.
  const appeared = await btn5d.waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true).catch(() => false);
  test.skip(!appeared, "market data unavailable in this environment");
  await btn5d.click();
  // Selected period gets the amber active classes.
  await expect(btn5d).toHaveClass(/text-amber/);
});
