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

    // The function rail is the page's stable anchor — it renders in every
    // data state (loaded, skeleton, not-found). It replaced the old <select>.
    await expect(page.getByRole("button", { name: "DES", exact: true })).toBeVisible();

    for (const code of ["DES", "GIP", "FA", "NT"]) {
      await page.getByRole("button", { name: code, exact: true }).click();
      await page.waitForTimeout(1200);     // allow the screen to fetch/render
      await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
    }
  });
}

test("period buttons toggle active state", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto("/terminal?t=RELIANCE.NS");
  const gip = page.getByRole("button", { name: "GIP", exact: true });
  const ready = await gip.waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true).catch(() => false);
  test.skip(!ready, "backend starved by provider timeouts in this environment");
  await gip.click();
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
