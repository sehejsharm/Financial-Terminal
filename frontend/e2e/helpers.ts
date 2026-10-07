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

/** Whether this context has already been signed in. */
let signedIn = false;

/**
 * Authenticate without touching the login form.
 *
 * Costs ONE request for the entire suite instead of one per test, which
 * keeps the run under the backend's own brute-force guard. That guard is
 * working as designed — the tests adapt to it rather than the other way
 * round.
 */
export async function signIn(page: Page) {
  // Posted at the FRONT END's origin, not the backend's, and that is the
  // whole trick. The app and the API are different origins, so the session
  // cookie has to be set by a response the browser sees as first-party —
  // next.config.js rewrites /api/v1/auth/* through this origin for exactly
  // that reason. Playwright's request context shares its cookie jar with the
  // browser context, so the refresh and CSRF cookies land where the page can
  // use them and the app bootstraps a session on first load.
  //
  // This replaced injecting an `mb_token` cookie directly. That stopped
  // working when the access token moved out of cookies and into memory: the
  // cookie was still set, nothing read it, and every test would have landed
  // on the sign-in screen.
  // Retried on a 5xx, because the thing that fails here is the NEXT DEV
  // rewrite proxy, not the API. Its 500 is an HTML "Internal Server Error"
  // page, where a real refusal from the API is JSON with a `detail`. The dev
  // proxy drops a POST now and then (it is the same http-proxy that emits the
  // util._extend deprecation warning), which showed up as this spec passing
  // alone and failing in sequence. Production does not use it — Vercel's own
  // rewrite serves that path — so retrying here is adapting to a dev-server
  // quirk rather than papering over a product defect.
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await page.request.post(
      "http://localhost:3000/api/v1/auth/login",
      { data: { username: ADMIN_USER, password: ADMIN_PASS } },
    );
    if (res.ok()) {
      signedIn = true;
      return;
    }
    last = `${res.status()} ${(await res.text()).slice(0, 200)}`;
    // Anything that is not a 5xx is a real answer from the API — a wrong
    // password, or the rate limiter — and retrying it just wastes the budget.
    if (res.status() < 500) break;
    await page.waitForTimeout(400);
  }
  throw new Error(`login failed: ${last}`);
}

/** True once signIn has run against this context. Exported for the auth spec. */
export function isSignedIn() {
  return signedIn;
}

/** A bearer token for specs that seed state through the API directly.
 *
 *  Cached for the whole run: it is an ACCESS token, which is stateless and
 *  replayable, so one is enough. Deliberately not used for signing the BROWSER
 *  in — the app holds its access token in memory and there is no way to put
 *  one there from outside without a test backdoor in production code.
 */
let apiTokenPromise: Promise<string> | null = null;
export async function apiToken(page: Page): Promise<string> {
  // Caching a REJECTED promise would poison the whole run: one transient
  // failure and every later call rethrows the same error forever, which is
  // how a single intermittent 500 turned into a test that passed alone and
  // failed in sequence. So the cache is populated only on success, and a
  // failure is retried once with the response body in the error.
  if (apiTokenPromise) {
    try {
      return await apiTokenPromise;
    } catch {
      apiTokenPromise = null;
    }
  }
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await page.request.post(
      "http://localhost:8000/api/v1/auth/login",
      { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (res.ok()) {
      const token = (await res.json()).access_token as string;
      apiTokenPromise = Promise.resolve(token);
      return token;
    }
    last = `${res.status()} ${(await res.text()).slice(0, 200)}`;
    await page.waitForTimeout(500);
  }
  throw new Error(`login failed: ${last}`);
}

/** Back-compat alias so existing specs keep working, now via the fast path. */
export const login = signIn;

/** The app's error boundaries render this copy — asserting its absence is
 *  the "did not crash" check. */
export const BOUNDARY_TEXT = "hit an error and was isolated";
