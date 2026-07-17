import { expect, test } from "@playwright/test";

import { ADMIN_USER, login } from "./helpers";

test("bad credentials show an error and stay on /login", async ({ page }) => {
  await page.goto("/login");
  await page.locator("form input").first().fill(ADMIN_USER);
  await page.locator('input[type="password"]').fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("good credentials land on the dashboard shell", async ({ page }) => {
  await login(page);
  // Shell nav renders its main links.
  await expect(page.getByRole("link", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Screeners" })).toBeVisible();
});
