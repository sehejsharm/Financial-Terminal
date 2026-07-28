import { expect, test } from "@playwright/test";

import { ADMIN_PASS, ADMIN_USER, BOUNDARY_TEXT } from "./helpers";

/**
 * Dashboard: layout editing, region switching and persistence.
 *
 * Market data may be unreachable from CI, so nothing here asserts on quote
 * values — the assertions are all on app-owned structure, which is what the
 * editing model actually guarantees.
 */

/**
 * One login for the whole file, reused as a cookie.
 *
 * Logging in per test trips the backend's own brute-force guard —
 * /api/v1/auth/login is capped at 10 requests per minute per IP — and the
 * later tests then silently land back on the sign-in screen. That limit is
 * working as designed, so the suite adapts to it rather than the other way
 * round. It's also several seconds faster.
 */
/** Token fetched at most once for the whole file, then replayed as a cookie. */
let tokenPromise: Promise<string> | null = null;

test.beforeEach(async ({ page }) => {
  tokenPromise ??= page.request
    .post("http://localhost:8000/api/v1/auth/login", {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
    })
    .then(async (res) => {
      if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
      return (await res.json()).access_token as string;
    });

  // The app reads its JWT from a non-HttpOnly cookie (see lib/api.ts).
  await page.context().addCookies([{
    name: "mb_token", value: await tokenPromise,
    url: "http://localhost:3000", sameSite: "Lax",
  }]);

  // Start from a known state. BOTH keys matter: the region-switch test
  // persists a home region, and leaving it set would rebuild every later
  // test's board around the wrong market.
  //
  // Cleared in an init script (before page scripts run) rather than by
  // navigate-evaluate-reload: the dashboard subscribes 60+ symbols per load,
  // so halving the page loads meaningfully de-flakes the suite. The
  // sessionStorage guard makes it fire once per test rather than on every
  // navigation — otherwise it would wipe the layout the persistence tests
  // are specifically checking survives a reload.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__e2e_reset")) {
      localStorage.removeItem("mb_dashboard_layout_v1");
      localStorage.removeItem("mb_home_region");
      sessionStorage.setItem("__e2e_reset", "1");
    }
  });
  await page.goto("/");
  await boardsReady(page);
});

/** The layout is read in an effect (reading localStorage during render would
 *  desync hydration on this statically-prerendered page), so the first paint
 *  is a placeholder. Wait for real sections before reading the DOM. */
async function boardsReady(page: import("@playwright/test").Page) {
  await expect(page.locator("section h2").first()).toBeVisible();
}

test("renders the status rail, market boards, and the lists below them", async ({ page }) => {
  await expect(page.getByText("Feed coverage")).toBeVisible();
  await expect(page.getByRole("heading", { name: /India · Indices/i })).toBeVisible();

  // The requested ordering: gainers/losers and watchlists are BELOW the
  // market tiles, reached by scrolling.
  const indices = await page.getByRole("heading", { name: /India · Indices/i })
    .first().boundingBox();
  const movers = await page.getByRole("heading", { name: /Gainers & losers/i })
    .first().boundingBox();
  const watch = await page.getByRole("heading", { name: /^Watchlists$/i })
    .first().boundingBox();
  expect(indices!.y).toBeLessThan(movers!.y);
  expect(movers!.y).toBeLessThan(watch!.y);

  // Both movers columns are visible at once — the old toggle showed one.
  await expect(page.getByText("Top gainers")).toBeVisible();
  await expect(page.getByText("Top losers")).toBeVisible();

  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});

test("exchange clocks show a real session state for the home region", async ({ page }) => {
  const rail = page.getByTestId("status-rail");
  await expect(rail.getByText("NSE", { exact: true })).toBeVisible();
  await expect(rail.getByText("NYSE", { exact: true })).toBeVisible();
  // Each clock renders an HH:MM wall time.
  await expect(rail.getByText(/^\d{2}:\d{2}$/).first()).toBeVisible();
});

test("a removed section stays removed after a reload", async ({ page }) => {
  await page.getByRole("button", { name: /Edit/ }).click();

  const heading = page.getByRole("heading", { name: /India · Sectors/i });
  await expect(heading).toBeVisible();
  // The section header's own remove button.
  await heading.locator("xpath=ancestor::section")
    .getByTitle("Remove this section").click();
  await expect(heading).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: /India · Sectors/i })).toHaveCount(0);
  // and the rest of the board survived
  await expect(page.getByRole("heading", { name: /India · Indices/i })).toBeVisible();
});

test("reordering a board persists", async ({ page }) => {
  await page.getByRole("button", { name: /Edit/ }).click();
  const titlesBefore = await page.locator("section h2").allInnerTexts();
  expect(titlesBefore.length).toBeGreaterThan(1);

  await page.locator("section").first().getByTitle("Move section down").click();
  const titlesAfter = await page.locator("section h2").allInnerTexts();
  expect(titlesAfter[0]).toBe(titlesBefore[1]);

  await page.reload();
  await boardsReady(page);
  const titlesReloaded = await page.locator("section h2").allInnerTexts();
  expect(titlesReloaded[0]).toBe(titlesBefore[1]);
});

test("adding a board from the picker puts it above the movers/watchlists", async ({ page }) => {
  await page.getByRole("button", { name: /Add board/ }).click();
  await expect(page.getByText("Add a board")).toBeVisible();

  const agri = page.getByRole("button", { name: /Agriculture/ });
  await agri.click();

  const board = page.getByRole("heading", { name: /^Agriculture$/ });
  await expect(board).toBeVisible();
  const boardBox = await board.boundingBox();
  const moversBox = await page.getByRole("heading", { name: /Gainers & losers/i })
    .first().boundingBox();
  expect(boardBox!.y).toBeLessThan(moversBox!.y);
});

test("switching home region rebuilds the board around that market", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await page.getByTitle(/Reorders the whole dashboard/).selectOption("US");

  // United States leads now, and it persists.
  await expect(page.locator("section h2").first()).toHaveText(/United States/i);
  await page.reload();
  await expect(page.locator("section h2").first()).toHaveText(/United States/i);
});

test("a corrupt saved layout falls back to the default instead of white-screening",
  async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("mb_dashboard_layout_v1", '{"version":1,"sections":[null,42]}');
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: /India · Indices/i })).toBeVisible();
    await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
  });

test("dense and hide-unpriced toggles apply without crashing", async ({ page }) => {
  await page.getByLabel(/Dense/).check();
  await expect(page.getByRole("heading", { name: /India · Indices/i })).toBeVisible();
  await page.getByLabel(/Hide unpriced/).check();
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
  await page.reload();
  // Both preferences survived the reload.
  await expect(page.getByLabel(/Dense/)).toBeChecked();
  await expect(page.getByLabel(/Hide unpriced/)).toBeChecked();
});
