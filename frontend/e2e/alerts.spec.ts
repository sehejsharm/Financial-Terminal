import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test("create and delete a price alert; test-alert reports a result", async ({ page }) => {
  await login(page);
  await page.goto("/alerts");

  await page.getByPlaceholder("RELIANCE.NS").fill("RELIANCE.NS");
  await page.locator('input[type="number"]').first().fill("1");
  await page.getByRole("button", { name: "Create alert" }).click();
  await expect(page.getByText("RELIANCE.NS").first()).toBeVisible();

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
