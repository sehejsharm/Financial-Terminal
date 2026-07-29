import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/**
 * Macro and News structure.
 *
 * Neither FRED nor the news wires are reachable from CI, so these assert on
 * what the app itself owns: the tab strip, the country picker, and the fact
 * that every data-less state is an explicit message rather than a blank
 * page. A page that silently renders nothing when its feed is down is the
 * bug worth catching here.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("macro opens on India, not the US", async ({ page }) => {
  await page.goto("/macro");
  await expect(page.getByRole("heading", { name: "MACRO" })).toBeVisible();
  // aria-pressed is the honest signal — the chip is a toggle, not a link.
  await expect(page.getByRole("button", { name: /India/ }))
    .toHaveAttribute("aria-pressed", "true");
});

test("macro exposes every section as a tab", async ({ page }) => {
  await page.goto("/macro");
  for (const name of ["Economy", "Sectors", "Yield curve", "Releases"]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }
});

test("the sectors tab always says something, data or not", async ({ page }) => {
  await page.goto("/macro");
  await page.getByRole("tab", { name: "Sectors" }).click();
  await expect(page.getByRole("tab", { name: "Sectors" }))
    .toHaveAttribute("aria-selected", "true");
  // Ratings, the loading state, or an honest failure — never a blank pane.
  await expect(
    page.getByText(/Sector ratings|Loading sector ratings|unavailable|No sectors/i).first(),
  ).toBeVisible({ timeout: 45_000 });
});

test("switching country keeps the page on the same tab", async ({ page }) => {
  await page.goto("/macro");
  await page.getByRole("tab", { name: "Releases" }).click();
  await page.getByRole("button", { name: /United States/ }).click();
  await expect(page.getByRole("button", { name: /United States/ }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: "Releases" }))
    .toHaveAttribute("aria-selected", "true");
});

test("news renders its wire tabs and never a blank pane", async ({ page }) => {
  await page.goto("/news");
  await expect(page.getByRole("heading", { name: "NEWS" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Market wire" })).toBeVisible();
  await expect(
    page.getByText(/headlines|No headlines|unavailable|Loading headlines/i).first(),
  ).toBeVisible({ timeout: 45_000 });
});

test("news by-ticker accepts a symbol", async ({ page }) => {
  await page.goto("/news");
  await page.getByRole("tab", { name: "By ticker" }).click();
  const box = page.getByPlaceholder("RELIANCE.NS");
  await expect(box).toBeVisible();
  await box.fill("TCS.NS");
  await box.press("Enter");
  await expect(box).toHaveValue("TCS.NS");
});
