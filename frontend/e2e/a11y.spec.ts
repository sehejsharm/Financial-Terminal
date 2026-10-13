import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers";

/**
 * Accessibility, in two halves.
 *
 * FIRST, the automated gate. axe over every route at WCAG 2.0/2.1 A and AA.
 * When this was first run, thirteen of fourteen routes were already clean and
 * /login had two CRITICAL `label` violations — the sign-in screen, where the
 * fields looked labelled but were not programmatically associated, so a screen
 * reader announced two unlabelled boxes on the one screen where knowing which
 * is which matters most.
 *
 * SECOND, and this is the part worth reading: AXE CANNOT TELL YOU AN APP IS
 * ACCESSIBLE. It catches roughly a third of WCAG problems — the mechanical
 * ones. It cannot tell whether the keyboard can reach anything, whether focus
 * is visible, whether focus is trapped in a drawer, whether the reading order
 * makes sense, or whether alt text says anything useful. A green axe run is a
 * floor, not a result. So the tests after the gate check the things it cannot.
 */

const ROUTES = ["/", "/terminal", "/screeners", "/portfolio", "/alerts",
  "/news", "/macro", "/global", "/quant", "/sharks", "/workspace",
  "/account", "/disclosures"];

async function axeOn(page: Page) {
  return new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // `nextjs-portal` is the custom element Next injects IN DEVELOPMENT for
    // its error overlay and build indicator. It is not part of this app, it
    // never reaches production, and its own contrast is Next's business — but
    // the suite runs `npm run dev`, so axe was scanning it.
    //
    // This was not theoretical. It is the CI failure recorded in
    // docs/OPEN-ITEMS.md §B2: on a runner where the market-data providers
    // return nothing, enough routes surfaced the dev overlay that five of them
    // reported `serious color-contrast x1 -> nextjs-portal,span` — a real red
    // build, caused entirely by Next's dev tooling, and indistinguishable at a
    // glance from a real violation. Excluding it is what makes the gate
    // measure the application.
    .exclude("nextjs-portal")
    .analyze();
}

/** A readable failure: axe's own output is enormous.
 *
 *  Includes the offending MARKUP, not just the selector. The first version
 *  printed `serious nested-interactive x1 -> .panel`, which names a class used
 *  in dozens of components and sent me grepping; the element's own html says
 *  which one it is immediately. A failure you cannot act on is only slightly
 *  better than no failure.
 */
function summarise(violations: Awaited<ReturnType<typeof axeOn>>["violations"]) {
  return violations.map((v) =>
    `${v.impact} ${v.id} x${v.nodes.length} -> ${v.nodes[0]?.target?.join(" ")}`
    + ` :: ${(v.nodes[0]?.html ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
}

test("the sign-in screen has no violations", async ({ page }) => {
  // Its own test because it is the one screen a user cannot skip, and because
  // it is where the only violations were.
  await page.goto("/login");
  await page.waitForTimeout(800);
  const { violations } = await axeOn(page);
  expect(summarise(violations)).toEqual([]);
});

test("the sign-in fields are programmatically labelled", async ({ page }) => {
  // Asserted directly as well as through axe, because this is the specific
  // defect and it should fail with an obvious message if it regresses.
  await page.goto("/login");
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("every signed-in route has no violations", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  const found: Record<string, string[]> = {};
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForTimeout(1500);
    const { violations } = await axeOn(page);
    if (violations.length) found[route] = summarise(violations);
  }
  expect(found).toEqual({});
});

// The two shapes a degraded data plane actually takes, because they render
// DIFFERENT things and only one of them is an error state.
//
//   "the api errors"  — every data call 503s. Pages show error states.
//   "market data is empty" — the API answers 200 with nothing in it, while the
//        app's OWN stores (portfolios, alerts, workspaces) still work. This is
//        the shape CI really has: the backend is up, and the market-data
//        providers behind it return "no data found" for symbol after symbol.
//        Pages show EMPTY states, which is a different rendering path — a table
//        with headers and no rows, a chart with no series, a figure replaced by
//        a dash.
//
// Guessing which one CI hit would have been a coin flip, so both run.
const DEGRADED = [
  {
    name: "the api errors",
    pattern: "http://localhost:8000/api/v1/**",
    body: { status: 503, body: { detail: "Upstream data provider unavailable." } },
  },
  {
    name: "market data comes back empty",
    // Only the provider-backed namespaces. The app's own stores are left
    // alone so these stay pages with a working session and real furniture.
    pattern: "http://localhost:8000/api/v1/{market,screens,macro,fundamentals,options,deals,value_chain}/**",
    body: { status: 200, body: {} },
  },
] as const;

for (const mode of DEGRADED) {
test(`every signed-in route has no violations WHEN ${mode.name}`, async ({ page }) => {
  // THE GAP THIS CLOSES. The gate above runs where data loads, so it only ever
  // measured the happy path. In CI, where the market-data providers are
  // unreachable, the same routes render error and empty states instead — and
  // that is arguably the case that matters more, because it is what a user
  // sees when something is wrong, and it is the moment they most need the page
  // to be navigable.
  //
  // It showed up the worst possible way: as a CI-only failure. The test passed
  // on every developer machine and failed on the runner, which makes it look
  // like infrastructure flake rather than a real violation, and that is how a
  // real violation gets ignored. So the degraded state is forced here rather
  // than waited for — every machine renders it, the result is the same
  // everywhere, and a violation in an error state fails the same way a
  // violation in a loaded state does.
  //
  // WHAT IS FAULTED, AND WHAT IS NOT: everything the app fetches from the API
  // origin (localhost:8000) returns 503. The auth endpoints are untouched
  // because the frontend reaches those through its OWN origin — next.config.js
  // rewrites /api/v1/auth/* so the session cookie is first-party — so the
  // session survives and these are genuinely signed-in pages with no data,
  // not the login screen wearing a disguise. Faulting the session too would
  // make this a second, slower copy of the sign-in test.
  //
  // 503 rather than abort(): in CI the backend is up and the PROVIDERS behind
  // it are not, so an HTTP error is the honest shape. It also exercises the
  // app's error-state rendering rather than its offline path, which
  // offline.spec.ts already covers.
  test.setTimeout(600_000);
  await signIn(page);
  await page.route(mode.pattern, (route) =>
    route.fulfill({
      status: mode.body.status,
      contentType: "application/json",
      body: JSON.stringify(mode.body.body),
    }));

  const found: Record<string, string[]> = {};
  for (const route of ROUTES) {
    await page.goto(route);
    // Longer than the happy-path pass: a degraded state appears only after the
    // request has been made and answered, and several of these routes retry.
    await page.waitForTimeout(2500);
    const { violations } = await axeOn(page);
    if (violations.length) found[route] = summarise(violations);
  }
  expect(found).toEqual({});
});
}

// ── what axe cannot check ────────────────────────────────────────────────

test("the sign-in form is operable by keyboard alone", async ({ page }) => {
  // A form that only works with a mouse passes every automated check.
  await page.goto("/login");
  const user = page.getByLabel("Username");
  await user.focus();
  await page.keyboard.type("e2e-admin");
  await page.keyboard.press("Tab");
  await page.keyboard.type("e2e-password-123");
  // Enter from inside the form submits it — no reaching for the button.
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
});

test("focus is visible on whatever the keyboard lands on", async ({ page }) => {
  // Removing the focus ring is the single most common accessibility
  // regression, it is invisible in a screenshot taken with a mouse, and axe
  // does not check it.
  await signIn(page);
  await page.goto("/");
  await page.waitForTimeout(1200);

  const unringed: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ringed = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0)
        || s.boxShadow !== "none";
      return ringed ? null : `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 40)}`;
    });
    if (r) unringed.push(r);
  }
  expect([...new Set(unringed)]).toEqual([]);
});

test("the skip link jumps past the navigation", async ({ page }) => {
  // It exists, which automated tools see. Whether it actually MOVES focus to
  // the content is the part that matters and is not checked by them.
  await signIn(page);
  await page.goto("/");
  await page.waitForTimeout(1000);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /skip to content/i });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeVisible();
});

test("Escape closes the mobile navigation drawer", async ({ page }) => {
  // A drawer that can be opened by keyboard and not closed by keyboard is a
  // trap, and a trap is worse than no drawer.
  await page.setViewportSize({ width: 390, height: 780 });
  await signIn(page);
  await page.goto("/");
  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: /More — open full navigation/ }).click();
  const close = page.getByRole("button", { name: "Close navigation" });
  await expect(close).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(close).toBeHidden({ timeout: 5000 });
});

test("the drawer moves focus in on open and back out on close", async ({ page }) => {
  // A modal that opens and leaves focus behind it tells a screen-reader user
  // a dialog appeared, then points them at the page underneath.
  await page.setViewportSize({ width: 390, height: 780 });
  await signIn(page);
  await page.goto("/");
  await page.waitForTimeout(1200);

  const opener = page.getByRole("button", { name: /More — open full navigation/ });
  await opener.click();
  await expect(page.getByRole("button", { name: "Close navigation" }))
    .toBeFocused();

  await page.keyboard.press("Escape");
  // Back to the control that opened it, not to the top of the document —
  // otherwise every close costs the user a full re-tab.
  await expect(opener).toBeFocused();
});

test("Tab stays inside the open drawer", async ({ page }) => {
  // Without a trap, Tab walks onto controls behind the backdrop that the user
  // cannot see and cannot make sense of.
  await page.setViewportSize({ width: 390, height: 780 });
  await signIn(page);
  await page.goto("/");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /More — open full navigation/ }).click();
  await expect(page.getByRole("button", { name: "Close navigation" }))
    .toBeFocused();

  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() =>
      !!document.activeElement?.closest('[role="dialog"]'));
    expect(inside, `focus escaped the drawer after ${i + 1} tabs`).toBe(true);
  }
});
