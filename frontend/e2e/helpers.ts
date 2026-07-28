import { expect, type Page } from "@playwright/test";

export const ADMIN_USER = "e2e-admin";
export const ADMIN_PASS = "e2e-password-123";

/**
 * Sign in via the login FORM. Use only where the form itself is under test —
 * the backend caps /auth/login at 10 requests per minute per IP, so a suite
 * that drives this per test knocks its own later tests back to the sign-in
 * screen. Everything else should use `signIn`.
 */
export async function loginViaForm(page: Page) {
  await page.goto("/login");
  await page.locator("form input").first().fill(ADMIN_USER);
  await page.locator('input[type="password"]').fill(ADMIN_PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Successful login redirects into the shell (sidebar wordmark visible).
  await expect(page.getByText("MOTHERBOARD").first()).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
}

/** One token for the whole run, replayed as a cookie. */
let tokenPromise: Promise<string> | null = null;

/**
 * Authenticate without touching the login form.
 *
 * Costs ONE request for the entire suite instead of one per test, which
 * keeps the run under the backend's own brute-force guard. That guard is
 * working as designed — the tests adapt to it rather than the other way
 * round.
 */
export async function signIn(page: Page) {
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
}

/** Back-compat alias so existing specs keep working, now via the fast path. */
export const login = signIn;

/** The app's error boundaries render this copy — asserting its absence is
 *  the "did not crash" check. */
export const BOUNDARY_TEXT = "hit an error and was isolated";
