import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test("create and delete a price alert; test-alert reports a result", async ({ page }) => {
  await login(page);
  await page.goto("/alerts");

  // Commit the symbol with Enter rather than relying on the click to blur it
  // first: the form reads committed state, and leaning on event ordering
  // between blur and click is what made this flake under a loaded backend.
  const sym = page.getByPlaceholder("RELIANCE.NS");
  await sym.fill("RELIANCE.NS");
  await sym.press("Enter");
  await expect(sym).toHaveValue("RELIANCE.NS");
  await page.locator('input[type="number"]').first().fill("1");
  await page.getByRole("button", { name: "Create alert" }).click();
  // The POST queues behind whatever else the single-worker backend is doing.
  await expect(page.getByText("RELIANCE.NS").first()).toBeVisible({ timeout: 30_000 });

  // Delivery test always reports SOMETHING (sent/failed/no channels).
  await page.getByRole("button", { name: "Send test alert" }).click();
  await expect(
    page.getByText(/sent ✓|failed|no delivery channels/i),
  ).toBeVisible({ timeout: 20_000 });

  // Delete (confirm dialog) — the alert row disappears.
  page.on("dialog", (d) => d.accept());
  await page.getByTitle("Delete alert").first().click();
  await expect(page.getByTitle("Delete alert")).toHaveCount(0);
});
