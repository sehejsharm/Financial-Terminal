import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

/**
 * What an installed app does with no network.
 *
 * This exists because of what it used to do. The access token lives in memory,
 * so a cold load has to refresh — and with no network that refresh fails. The
 * gate read the failure as "not signed in" and redirected, so opening the
 * installed app on the metro showed a LOGIN FORM, which cannot possibly
 * succeed without a connection. Measured before the fix:
 *
 *   url: "/login", hasShell: false
 *
 * Being unable to reach the server is not the same as being signed out, and it
 * deserves a different screen: keep the shell, say what is wrong, keep
 * retrying.
 */
test.use({ viewport: { width: 390, height: 664 } });

test("a cold load with no network keeps the app, not the login form",
  async ({ page, context }) => {
    await signIn(page);
    await page.goto("/");
    // The service worker has to be in charge before the shell can be served
    // from cache at all.
    await expect.poll(
      () => page.evaluate(() => !!navigator.serviceWorker?.controller),
      { timeout: 20_000 },
    ).toBe(true);

    // One more load WHILE ONLINE, now that the worker is in charge. The first
    // navigation happened before it took control, so nothing was cached from
    // it — which means a user's very first visit has no offline shell and
    // falls back to the worker's inline "you're offline" page. From the second
    // visit on, this is what they get.
    await page.reload();
    await page.waitForTimeout(1500);

    await context.setOffline(true);
    try {
      await page.goto("/").catch(() => { /* the document may come from cache */ });

      // The bug: this was "/login".
      await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
      // And the shell is still there, so whatever was cached is still usable.
      await expect(page.getByRole("navigation", { name: "Primary" }))
        .toBeVisible({ timeout: 15_000 });
      // And it says so, rather than leaving stale figures looking current.
      await expect(page.getByRole("status").filter({ hasText: /Offline/ }))
        .toBeVisible({ timeout: 15_000 });
    } finally {
      await context.setOffline(false);
    }
  });

test("it recovers by itself when the network comes back", async ({ page, context }) => {
  // Requiring a manual reload to recover is a bad answer on a phone, where
  // signal comes and goes without the user doing anything.
  await signIn(page);
  await page.goto("/");
  await expect.poll(
    () => page.evaluate(() => !!navigator.serviceWorker?.controller),
    { timeout: 20_000 },
  ).toBe(true);

  await page.reload();
  await page.waitForTimeout(1500);

  await context.setOffline(true);
  await page.goto("/").catch(() => {});
  await expect(page.getByRole("status").filter({ hasText: /Offline/ }))
    .toBeVisible({ timeout: 15_000 });

  await context.setOffline(false);
  // The gate retries every 5s, so this must clear with no interaction at all.
  //
  // Generous timeout on purpose, and not because the behaviour is slow: the
  // Next dev rewrite proxy intermittently 500s, and a 5xx deliberately KEEPS
  // the app in offline mode (a broken server is not a sign-out). So a dropped
  // retry just means the next one recovers, and a tight bound here would be
  // testing the dev proxy's reliability rather than the retry loop.
  await expect(page.getByRole("status").filter({ hasText: /Offline/ }))
    .toBeHidden({ timeout: 60_000 });
});
