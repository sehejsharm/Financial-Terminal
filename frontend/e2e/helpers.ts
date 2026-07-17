import { expect, type Page } from "@playwright/test";

export const ADMIN_USER = "e2e-admin";
export const ADMIN_PASS = "e2e-password-123";

/** Sign in via the login form (fields have no placeholders — first input is
 *  username (autoFocus), the password input is type=password). */
export async function login(page: Page) {
  await page.goto("/login");
  await page.locator("form input").first().fill(ADMIN_USER);
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Successful login redirects into the shell (sidebar wordmark visible).
  await expect(page.getByText("MOTHERBOARD").first()).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The app's error boundaries render this copy — asserting its absence is
 *  the "did not crash" check. */
export const BOUNDARY_TEXT = "hit an error and was isolated";
