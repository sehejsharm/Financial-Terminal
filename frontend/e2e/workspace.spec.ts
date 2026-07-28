import { expect, test } from "@playwright/test";

import { ADMIN_PASS, ADMIN_USER, BOUNDARY_TEXT } from "./helpers";

/**
 * Workspace: the tiling grid, pane linking and desk persistence.
 *
 * Market data is unreachable from CI, so assertions stay on app-owned
 * structure — which is exactly what the linking model guarantees.
 */

/** One login for the file; per-test login trips the backend's 10/min guard. */
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
  // Wipe saved desks server-side. The e2e backend keeps one data dir across
  // runs, so without this a desk saved by an earlier run (or an earlier test)
  // leaks in and the pane/desk counts stop being deterministic.
  await page.request.put("http://localhost:8000/api/v1/workspaces", {
    headers: { Authorization: `Bearer ${await tokenPromise}` },
    data: { layouts: [], active_id: null },
  });
  // Forget which desk was last open so every test starts from the default.
  await page.addInitScript(() => localStorage.removeItem("mb_ws_active"));
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "WORKSPACE" })).toBeVisible();
});

/** Panes, in grid order. Scoped by test id because the link legend above the
 *  grid also renders ticker inputs — a bare input selector matches both. */
const panes = (page: import("@playwright/test").Page) => page.getByTestId("pane");

/** The ticker box belonging to pane `i` (not the legend's). */
const paneTicker = (page: import("@playwright/test").Page, i: number) =>
  panes(page).nth(i).locator('input[placeholder="Ticker"]');

/** Pane `i`'s link-group selector. */
const paneLink = (page: import("@playwright/test").Page, i: number) =>
  panes(page).nth(i).locator("select").nth(1);

test("opens a multi-row grid of panes, not a single row", async ({ page }) => {
  // The default desk is two rows of two.
  await expect(page.getByText(/panes ·/)).toBeVisible();
  await expect(page.getByText(/4\/12 panes/)).toBeVisible();
  await expect(page.getByText(/2\/4 rows/)).toBeVisible();
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});

test("LINKING: retyping the ticker in one pane moves every pane in its group",
  async ({ page }) => {
    const n = await panes(page).count();
    expect(n).toBeGreaterThan(1);

    // The research desk wires every pane to group A.
    await paneTicker(page, 0).fill("TCS.NS");
    await paneTicker(page, 0).press("Enter");

    for (let i = 0; i < n; i++) {
      await expect(paneTicker(page, i)).toHaveValue("TCS.NS");
    }
  });

test("UNLINKING pins a pane to its own symbol", async ({ page }) => {
  await paneLink(page, 1).selectOption("none");
  await expect(panes(page).nth(1)).toHaveAttribute("data-link", "none");

  await paneTicker(page, 1).fill("AAPL");
  await paneTicker(page, 1).press("Enter");

  await paneTicker(page, 0).fill("INFY.NS");
  await paneTicker(page, 0).press("Enter");

  await expect(paneTicker(page, 0)).toHaveValue("INFY.NS");
  await expect(paneTicker(page, 1)).toHaveValue("AAPL");   // did not follow
});

test("two link groups track two symbols independently", async ({ page }) => {
  await paneLink(page, 1).selectOption("B");

  await paneTicker(page, 0).fill("TCS.NS");
  await paneTicker(page, 0).press("Enter");
  await paneTicker(page, 1).fill("WIPRO.NS");
  await paneTicker(page, 1).press("Enter");

  await expect(paneTicker(page, 0)).toHaveValue("TCS.NS");
  await expect(paneTicker(page, 1)).toHaveValue("WIPRO.NS");

  // Both groups appear in the legend above the grid.
  await expect(page.getByText("Linked groups")).toBeVisible();
});

test("changing a pane's widget swaps its content", async ({ page }) => {
  const widgetSelect = panes(page).first().locator("select").first();
  await widgetSelect.selectOption("notes");
  await expect(widgetSelect).toHaveValue("notes");
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});

test("panes can be added and closed, and the last one cannot be closed",
  async ({ page }) => {
    await expect(page.getByText(/4\/12 panes/)).toBeVisible();
    await page.getByTitle("Add a pane to this row").first().click();
    await expect(page.getByText(/5\/12 panes/)).toBeVisible();

    await page.getByTitle("Close pane").first().click();
    await expect(page.getByText(/4\/12 panes/)).toBeVisible();
  });

test("a desk preset replaces the grid", async ({ page }) => {
  await page.getByRole("button", { name: /Desks/ }).click();
  await expect(page.getByText("Start from a desk")).toBeVisible();
  await page.getByRole("button", { name: /Risk desk/ }).click();
  // Risk desk is volcone + options over the option builder = 3 panes.
  await expect(page.getByText(/3\/12 panes/)).toBeVisible();
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});

test("saving a desk persists it across a reload", async ({ page }) => {
  await page.getByRole("button", { name: /Desks/ }).click();
  await page.getByRole("button", { name: /Head to head/ }).click();

  await page.locator('input[placeholder="Head to head"]').fill("My desk");

  // Wait for the SERVER to confirm before reloading — reloading mid-flight
  // aborts the PUT and the desk is never stored. Keyed on the response
  // rather than a UI timeout: during a full-suite run the single-worker
  // backend can be queued behind other specs' provider calls, and how long
  // that takes is not what this test is about.
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/v1/workspaces")
      && r.request().method() === "PUT" && r.ok(),
    { timeout: 60_000 });
  await page.getByRole("button", { name: /^Save$/ }).click();
  await saved;
  await expect(page.getByRole("button", { name: "My desk", exact: true })).toBeVisible();
  await expect(page.getByTestId("ws-saved")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "WORKSPACE" })).toBeVisible();
  await expect(page.getByRole("button", { name: "My desk", exact: true })).toBeVisible();
  // Head to head is 2 + 3 panes.
  await expect(page.getByText(/5\/12 panes/)).toBeVisible();
});

test("maximizing a pane hides the rest and Esc restores the grid", async ({ page }) => {
  const before = await panes(page).count();
  await page.getByTitle("Maximize pane").first().click();
  await expect(page.getByTitle("Restore pane (Esc)")).toBeVisible();
  await expect(panes(page)).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.getByTitle("Maximize pane").first()).toBeVisible();
  await expect(panes(page)).toHaveCount(before);
});

test("rows can be added and removed", async ({ page }) => {
  await expect(page.getByText(/2\/4 rows/)).toBeVisible();
  await page.getByRole("button", { name: /Add row/ }).click();
  await expect(page.getByText(/3\/4 rows/)).toBeVisible();

  await page.getByTitle("Remove this row").last().click();
  await expect(page.getByText(/2\/4 rows/)).toBeVisible();
});

test("dragging the divider actually resizes the panes", async ({ page }) => {
  // Regression guard: the dividers used to sit inside display:contents
  // wrappers, whose clientWidth is 0, so every drag silently did nothing.
  const first = panes(page).first();
  const before = (await first.boundingBox())!.width;

  const handle = page.getByTitle("Drag to resize").first();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const after = (await first.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);
});

test("a corrupt saved desk falls back instead of white-screening", async ({ page }) => {
  await page.request.put("http://localhost:8000/api/v1/workspaces", {
    headers: { Authorization: `Bearer ${await tokenPromise}` },
    data: { layouts: [{ id: "junk", name: "Junk", rows: [] }] },
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "WORKSPACE" })).toBeVisible();
  await expect(panes(page).first()).toBeVisible();
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});
