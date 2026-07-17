import { expect, test } from "@playwright/test";

import { login } from "./helpers";

// The summary endpoint waits on market-data providers; when they're blocked
// (CI) each quote can take a 20s socket timeout before the row renders.
test.setTimeout(360_000);

test("add a position, see it listed, close it", async ({ page }) => {
  await login(page);
  await page.goto("/portfolio");

  // Add-position form: ticker autocomplete input + qty + cost. If the form
  // never becomes interactive the backend is starved by provider timeouts
  // (sandbox/CI without market-data egress) — skip rather than flake.
  const tickerInput = page.getByPlaceholder("RELIANCE.NS / AAPL");
  const ready = await tickerInput.waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true).catch(() => false);
  test.skip(!ready, "backend starved by provider timeouts in this environment");

  // Relative counts: the shared e2e data dir may carry rows from earlier
  // runs — assert the delta, not absolute emptiness.
  const rows = page.getByRole("link", { name: "RELIANCE.NS" });
  // Wait for the summary to actually render (holdings table or the
  // first-run empty state) before counting — with providers timing out it
  // can take a couple of minutes to settle.
  await expect(
    page.getByRole("columnheader", { name: "Qty" })
      .or(page.getByText(/no positions yet/i)),
  ).toBeVisible({ timeout: 150_000 });
  const before = await rows.count();

  await tickerInput.fill("RELIANCE.NS");
  const numInputs = page.locator('input[type="number"]');
  await numInputs.nth(0).fill("2");
  await numInputs.nth(1).fill("100");
  await page.getByRole("button", { name: "Add position" }).click();
  await expect(rows).toHaveCount(before + 1, { timeout: 120_000 });

  // Close flow prompts for a sell price — blank means "just remove".
  page.on("dialog", (d) => d.accept(""));
  await page.getByTitle(/close position/i).first().click();
  await expect(rows).toHaveCount(before, { timeout: 120_000 });
});
