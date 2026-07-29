import { expect, test } from "@playwright/test";

import { ADMIN_PASS, ADMIN_USER, BOUNDARY_TEXT } from "./helpers";

/**
 * Terminal navigation: the function rail, the command line, keyboard
 * shortcuts and symbol history.
 *
 * Market data is unreachable from CI, so these assert on navigation and URL
 * state — which is what the command line actually guarantees.
 */

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
  await page.context().addCookies([{
    name: "mb_token", value: await tokenPromise,
    url: "http://localhost:3000", sameSite: "Lax",
  }]);
  await page.goto("/terminal?t=RELIANCE.NS");
  await expect(page.getByRole("button", { name: "DES", exact: true })).toBeVisible();
});

const cmd = (page: import("@playwright/test").Page) =>
  page.locator('input[placeholder^="Symbol, function"]');

/**
 * Keyboard shortcuts live on a window listener attached after hydration. The
 * rail is server rendered, so waiting for a button to be visible proves
 * nothing about whether a keystroke will be heard — pressing before the
 * listener exists was the whole source of the intermittent failures here.
 */
const shortcutsLive = (page: import("@playwright/test").Page) =>
  expect(page.locator('[data-shortcuts="live"]')).toBeAttached({ timeout: 30_000 });

test("every function is reachable from the rail without opening a menu", async ({ page }) => {
  // The old UI hid 16 screens behind a <select>.
  for (const code of ["DES", "GIP", "FA", "EE", "CS", "DDIS", "ERN",
                      "CF", "ANR", "OWN", "OMON", "WACC", "SPLC", "AI", "CN", "NT"]) {
    await expect(page.getByRole("button", { name: code, exact: true })).toBeVisible();
  }
});

test("clicking a rail button switches screen and writes it to the URL", async ({ page }) => {
  await page.getByRole("button", { name: "FA", exact: true }).click();
  await expect(page).toHaveURL(/fn=Financials/);
  await expect(page.getByRole("button", { name: "FA", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});

test("a deep link with a MNEMONIC opens that screen", async ({ page }) => {
  await page.goto("/terminal?t=RELIANCE.NS&fn=OMON");
  await expect(page.getByRole("button", { name: "OMON", exact: true }))
    .toHaveAttribute("aria-current", "page");
});

test("a deep link with a junk fn leaves the default screen alone", async ({ page }) => {
  await page.goto("/terminal?t=RELIANCE.NS&fn=NOT_A_FUNCTION");
  // Wait for the rail to mount before asserting its state. The Shell gates
  // rendering on /auth/me, which under a full-suite run can queue behind the
  // single-worker backend's provider calls.
  const des = page.getByRole("button", { name: "DES", exact: true });
  await expect(des).toBeVisible({ timeout: 45_000 });
  await expect(des).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});

test("command line: a bare mnemonic jumps screens on the current symbol",
  async ({ page }) => {
    await cmd(page).fill("FA");
    await cmd(page).press("Enter");
    await expect(page).toHaveURL(/fn=Financials/);
    await expect(page).toHaveURL(/t=RELIANCE.NS/);
  });

test("command line: SYMBOL + CODE navigates and switches in one go", async ({ page }) => {
  await cmd(page).fill("TCS.NS OMON");
  await cmd(page).press("Enter");
  await expect(page).toHaveURL(/t=TCS.NS/);
  await expect(page).toHaveURL(/fn=Options/);
});

test("command line: a plain symbol navigates and keeps the current screen",
  async ({ page }) => {
    await page.getByRole("button", { name: "CN", exact: true }).click();
    await expect(page).toHaveURL(/fn=Recent\+news|fn=Recent%20news/);

    await cmd(page).fill("TCS.NS");
    await cmd(page).press("Enter");
    await expect(page).toHaveURL(/t=TCS.NS/);
    await expect(page.getByRole("button", { name: "CN", exact: true }))
      .toHaveAttribute("aria-current", "page");
  });

test("[ and ] cycle screens", async ({ page }) => {
  await shortcutsLive(page);
  await expect(page.getByRole("button", { name: "DES", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.locator("body").press("]");
  await expect(page.getByRole("button", { name: "GIP", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.locator("body").press("[");
  await expect(page.getByRole("button", { name: "DES", exact: true }))
    .toHaveAttribute("aria-current", "page");
});

test("'/' focuses the command line", async ({ page }) => {
  await shortcutsLive(page);
  await page.locator("body").press("/");
  await expect(cmd(page)).toBeFocused();
});

test("shortcuts do NOT fire while typing in a field", async ({ page }) => {
  await shortcutsLive(page);
  await cmd(page).click();
  await cmd(page).fill("");
  await cmd(page).type("]");
  // Still on the default screen, and the character landed in the box.
  await expect(page.getByRole("button", { name: "DES", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect(cmd(page)).toHaveValue("]");
});

test("back and forward walk the symbol history", async ({ page }) => {
  await cmd(page).fill("TCS.NS");
  await cmd(page).press("Enter");
  await expect(page).toHaveURL(/t=TCS.NS/);

  await page.getByRole("button", { name: "Back to the previous symbol", exact: true }).click();
  await expect(page).toHaveURL(/t=RELIANCE.NS/);

  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page).toHaveURL(/t=TCS.NS/);
});

test("back is disabled with nowhere to go", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Back to the previous symbol", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Forward", exact: true })).toBeDisabled();
});

test("the quote header shows the full stat strip", async ({ page }) => {
  const head = page.getByTestId("quote-header");
  for (const label of ["Prev close", "Bid / Ask", "Volume", "vs 50d", "vs 200d",
                       "Market cap", "52-week range"]) {
    await expect(head.getByText(label, { exact: true })).toBeVisible();
  }
});

test("the snapshot cards do NOT repeat what the header already shows",
  async ({ page }) => {
    // Market cap and the 52-week range live in the quote header now; showing
    // them again below would be two places to read one number.
    await expect(page.getByText("Market cap", { exact: true })).toHaveCount(1);
    await expect(page.getByText("52-week range", { exact: true })).toHaveCount(1);
    // These two render from the snapshot endpoint, which is a live provider
    // call — under a full-suite run it queues behind everything else the
    // single-worker backend is doing, and the default 15s expect timeout is
    // not enough. The rest of this file asserts app-owned structure and
    // needs no such allowance.
    await expect(page.getByText("Trailing P/E", { exact: true }))
      .toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Forward P/E", { exact: true }))
      .toBeVisible({ timeout: 45_000 });
  });
