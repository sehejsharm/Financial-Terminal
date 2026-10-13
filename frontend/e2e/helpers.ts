import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/** The master admin seeded by the backend's own env in playwright.config.ts.
 *
 *  Used for two things only: driving the login FORM (where the form is what is
 *  under test), and provisioning the per-spec accounts below. Specs do not
 *  sign in as this account any more — see `signIn`.
 */
export const ADMIN_USER = "e2e-admin";
export const ADMIN_PASS = "e2e-password-123";

// ── per-spec accounts ───────────────────────────────────────────────────────
//
// THE PROBLEM THIS SOLVES, measured rather than guessed. Every one of the 28
// spec files signed in as e2e-admin, so they shared one account's portfolios,
// watchlists, workspaces, alerts and notes. The suite's own comments record
// the consequence in three separate places — "which showed up as the test
// passing alone and failing in sequence" — and each site had grown its own
// workaround: workspace.spec.ts wipes every desk in a beforeEach,
// touch-targets.spec.ts deletes the portfolio it created in a finally. Those
// are patches on the symptom. The cause is that twenty-eight files were
// writing to one user's rows.
//
// So each spec file now gets its own account, derived from its filename. The
// data directory is still shared — it has to be, because one backend process
// serves the whole run and MB_DATA_DIR is fixed at boot — but the app already
// partitions every store BY USER (tests/test_account_isolation.py pins that),
// so per-account is the isolation boundary that actually exists here. A
// per-spec data directory would mean a backend restart per spec file: minutes
// of boot time, and it would isolate along a seam the app does not have.
//
// What this does NOT fix: two tests inside ONE spec file still share an
// account, which is correct — they are meant to, and Playwright already gives
// each test a fresh browser context.
//
// Nothing in the spec files changed. `signIn` is the one door they all go
// through, and it reads the current file from `test.info()`, so isolation is
// structural rather than something each spec has to remember to ask for.

const BACKEND = "http://localhost:8000";
const FRONTEND = "http://localhost:3000";

/** The account for whichever spec file is running right now.
 *
 *  Lowercased because lib/auth keys the user table on `username.lower()`, so
 *  a mixed-case name would create one record and look up another.
 */
function specAccount(): { user: string; pass: string } {
  const base = path.basename(test.info().file).replace(/\.spec\.ts$/, "");
  const slug = base.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  return { user: `e2e-${slug}`, pass: ADMIN_PASS };
}

/** Master-admin token, for provisioning only. Cached for the worker. */
let masterTokenPromise: Promise<string> | null = null;
async function masterToken(page: Page): Promise<string> {
  if (masterTokenPromise) {
    try {
      return await masterTokenPromise;
    } catch {
      masterTokenPromise = null;   // never cache a rejection; see apiToken
    }
  }
  const p = (async () => {
    const res = await page.request.post(`${BACKEND}/api/v1/auth/login`,
      { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (!res.ok()) {
      throw new Error(`master login failed: ${res.status()} `
        + `${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()).access_token as string;
  })();
  const token = await p;
  masterTokenPromise = Promise.resolve(token);
  return token;
}

const provisioned = new Set<string>();

/** Create this spec's account if it does not exist, and put it on a plan. */
async function provision(page: Page, user: string, pass: string) {
  if (provisioned.has(user)) return;
  const headers = { Authorization: `Bearer ${await masterToken(page)}` };

  // A 400 here is almost always "already exists", which is the normal case on
  // a re-run against a data dir that survived. Not treated as an error: the
  // plan call below is the one that has to succeed, and it would fail loudly
  // if the account genuinely were not there.
  await page.request.post(`${BACKEND}/api/v1/admin/users`, {
    headers, data: { username: user, password: pass, role: "user" },
  });

  // PRO, and BEFORE the first login, both deliberately.
  //
  // Pro because e2e-admin is a master admin and the specs were written against
  // whatever it could reach; dropping them onto the free tier's limits (10
  // alerts, 1 workspace, metered screens) would make this change look like a
  // batch of product regressions. Isolating the specs must not also re-tier
  // them.
  //
  // Before the login because the plan rides in the ACCESS TOKEN — see the note
  // on the admin set_plan route. Set it afterwards and the gates keep reading
  // the old tier until the token rolls over, which inside a 60-second test is
  // never.
  const res = await page.request.post(
    `${BACKEND}/api/v1/admin/users/${encodeURIComponent(user)}/plan?plan=pro`,
    { headers });
  if (!res.ok()) {
    throw new Error(`could not provision ${user}: ${res.status()} `
      + `${(await res.text()).slice(0, 300)}`);
  }
  provisioned.add(user);
}

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
  const { user, pass } = specAccount();
  await provision(page, user, pass);
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
      `${FRONTEND}/api/v1/auth/login`,
      { data: { username: user, password: pass } },
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
 *  Scoped to THE SAME per-spec account the browser is signed in as, and keyed
 *  by it. That identity has to match or the helper is worse than useless:
 *  state seeded as one user and then looked for in another user's view is a
 *  test that fails with an empty page and no indication why.
 *
 *  Cached per account rather than per run: an ACCESS token is stateless and
 *  replayable, so one per account is enough. Deliberately not used for signing
 *  the BROWSER in — the app holds its access token in memory and there is no
 *  way to put one there from outside without a test backdoor in production
 *  code.
 */
const apiTokens = new Map<string, Promise<string>>();
export async function apiToken(page: Page): Promise<string> {
  const { user, pass } = specAccount();
  await provision(page, user, pass);

  // Caching a REJECTED promise would poison the whole run: one transient
  // failure and every later call rethrows the same error forever, which is
  // how a single intermittent 500 turned into a test that passed alone and
  // failed in sequence. So the cache is populated only on success, and a
  // failure is retried once with the response body in the error.
  const cached = apiTokens.get(user);
  if (cached) {
    try {
      return await cached;
    } catch {
      apiTokens.delete(user);
    }
  }
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await page.request.post(
      `${BACKEND}/api/v1/auth/login`,
      { data: { username: user, password: pass } });
    if (res.ok()) {
      const token = (await res.json()).access_token as string;
      apiTokens.set(user, Promise.resolve(token));
      return token;
    }
    last = `${res.status()} ${(await res.text()).slice(0, 200)}`;
    await page.waitForTimeout(500);
  }
  throw new Error(`login failed for ${user}: ${last}`);
}

/** Back-compat alias so existing specs keep working, now via the fast path. */
export const login = signIn;

/** The app's error boundaries render this copy — asserting its absence is
 *  the "did not crash" check. */
export const BOUNDARY_TEXT = "hit an error and was isolated";
