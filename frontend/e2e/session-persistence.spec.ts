import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

/**
 * A session has to survive a page reload.
 *
 * This exists because it did not. The access token now lives in memory (it was
 * a 12-hour JWT in a readable cookie, which any XSS could lift), so a reload
 * starts with nothing and has to exchange the HttpOnly refresh cookie for a
 * new one. That exchange sends a CSRF token the client reads from
 * document.cookie — and the cookie was scoped to /api/v1/auth, which a page at
 * "/" cannot see (RFC 6265 5.1.4). So the refresh got a 403 and the user was
 * bounced to /login on every single reload.
 *
 * Nothing in the unit suite caught it: those tests set the CSRF value
 * explicitly rather than reading a cookie, which is exactly the step that was
 * broken. It needs a real browser with a real cookie jar, which is this file.
 */
// The signed-in shell, and nothing else, has a sign-out control. Asserting
// on the "MOTHERBOARD" wordmark instead is useless: the LOGIN page shows it
// too, so the assertion passes whether or not the session survived — which it
// did when first written, in both the broken and the fixed state.
const SIGNED_IN = { role: "button" as const, name: "Sign out" };

/** Let the auth gate finish before asserting where we ended up.
 *
 *  Needed because the redirect to /login is client-side and happens AFTER an
 *  async refresh round trip. Asserting immediately passes while the shell is
 *  still on screen, so the first version of these tests passed even with the
 *  bug present — which was worse than having no test, because it looked like
 *  coverage. */
async function settled(page: import("@playwright/test").Page) {
  // Deliberately NOT waitForLoadState("networkidle"): this app holds a live
  // WebSocket for quotes, so the network is never idle and that call simply
  // times out. Instead, wait until one of the two possible OUTCOMES is on
  // screen — signed in, or bounced to /login — which is both faster and the
  // thing actually being decided.
  await Promise.race([
    page.getByRole(SIGNED_IN.role, { name: SIGNED_IN.name })
      .waitFor({ state: "visible", timeout: 15_000 }).catch(() => {}),
    page.waitForURL(/\/login/, { timeout: 15_000 }).catch(() => {}),
  ]);
  // A beat for a redirect that is already in flight, so a pass is not just a
  // race won.
  await page.waitForTimeout(400);
}

test("a signed-in session survives a reload", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await settled(page);
  await expect(page.getByRole(SIGNED_IN.role, { name: SIGNED_IN.name }))
    .toBeVisible();

  await page.reload();
  await settled(page);

  // The bug: a reload started with no token in memory, could not read the
  // CSRF cookie to refresh, got three 403s, and bounced to /login.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole(SIGNED_IN.role, { name: SIGNED_IN.name }))
    .toBeVisible();
});

test("the session survives opening a deep route cold", async ({ page }) => {
  // Same failure, different entry point: a bookmark or a shared link is a
  // cold load with nothing in memory.
  await signIn(page);
  await page.goto("/screeners");
  await settled(page);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole(SIGNED_IN.role, { name: SIGNED_IN.name }))
    .toBeVisible();
});

test("the csrf cookie is readable by the page that needs it", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  // Asserted through document.cookie rather than the cookie jar, because the
  // jar holds cookies the page cannot see and the client reads this one with
  // document.cookie.
  const visible = await page.evaluate(() => document.cookie);
  expect(visible).toContain("mb_csrf");
  // And the session cookie must NOT be readable — that is the point of it.
  expect(visible).not.toContain("mb_refresh");
});
