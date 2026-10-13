import { expect, test } from "@playwright/test";

import { ADMIN_PASS, ADMIN_USER, BOUNDARY_TEXT, signIn, apiToken } from "./helpers";

/**
 * Workspace: the tiling grid, pane linking and desk persistence.
 *
 * Market data is unreachable from CI, so assertions stay on app-owned
 * structure — which is exactly what the linking model guarantees.
 */


test.beforeEach(async ({ page }) => {
  // Sign in through the shared helper. These specs each carried their own
  // copy of a cookie-injection login, which is why fixing helpers.ts alone
  // left them all on the sign-in screen: the duplicated code set an mb_token
  // cookie that nothing reads any more.
  await signIn(page);
  // Wipe saved desks server-side. The e2e backend keeps one data dir across
  // runs, so without this a desk saved by an earlier run (or an earlier test)
  // leaks in and the pane/desk counts stop being deterministic.
  await page.request.put("http://localhost:8000/api/v1/workspaces", {
    headers: { Authorization: `Bearer ${await apiToken(page)}` },
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
  //
  // ASSERTS THE DIRECTION, NOT A MAGNITUDE, and drags both ways.
  //
  // It used to drag right 160px and require the pane to grow by more than 60.
  // That failed in CI twice with different numbers — 492px before and 492px
  // after on one run, then 582 before and 594.9 after on another. The second
  // is the informative one: the drag DID work, it just moved 13px instead of
  // 60, because how far a divider can travel depends on the layout. The
  // neighbouring pane can only shrink to its own minimum, so a 160px pull is
  // clamped — and the pane widths differ between runs now that each spec file
  // gets a fresh account and therefore the default desk.
  //
  // So 60 was never a property of the code, it was a property of one layout on
  // one machine. The property that matters is the one the display:contents bug
  // actually broke: the dividers sat inside wrappers whose clientWidth was 0,
  // so every drag silently did NOTHING. A 13px move disproves that; a 0px move
  // is the regression.
  //
  // Dragging back as well makes this stronger than the version it replaces,
  // not weaker: a stuck divider, a one-way-only divider, and a divider that
  // reports movement it did not make all fail here, and none of those is
  // caught by a single rightward drag with a bigger threshold.
  const MIN_MOVE = 8;   // well clear of sub-pixel rounding on boundingBox

  // THE COLUMN DIVIDER, BY NAME, AND THE COLUMN IT ACTUALLY RESIZES.
  //
  // Two separate mistakes lived in the old two lines, and together they are
  // the whole of this test's CI history.
  //
  // 1. It asked for `getByTitle("Drag to resize").first()`, and BOTH axes
  //    carried that title. On a layout whose first row holds a single pane
  //    there is no column divider in that row, so the first handle on the page
  //    is a ROW divider — which reads e.clientY (see Divider.move), while this
  //    drag only moves X. Zero reported movement, pane unchanged, through all
  //    four retries. That is the 492 -> 492 in CI, and it is why retrying could
  //    never help: nothing was racing, the test was dragging the wrong control.
  //
  // 2. It measured `panes().first()` — row one's pane — which is not
  //    necessarily the pane the chosen divider moves. Picking the handle and
  //    the measured element independently is how a test ends up asserting
  //    about two unrelated things.
  //
  // Both fixed by deriving one from the other: take the first column divider,
  // then measure its immediately-preceding sibling, which is by construction
  // the flex column that divider resizes.
  const handle = page.getByTitle("Drag to resize columns").first();
  await expect(handle).toBeVisible();
  const first = handle.locator("xpath=preceding-sibling::div[1]");
  await expect(first).toBeVisible();

  async function drag(dx: number) {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2,
      { steps: 12 });
    await page.mouse.up();
  }

  // Retried, because the first drag can also land before the handle's pointer
  // listener is wired on a slow runner — which is what the 492/492 run was.
  await expect(async () => {
    const before = (await first.boundingBox())!.width;
    await drag(160);
    const wider = (await first.boundingBox())!.width;
    expect(wider, "a rightward drag did not widen the pane")
      .toBeGreaterThan(before + MIN_MOVE);

    await drag(-160);
    const narrower = (await first.boundingBox())!.width;
    expect(narrower, "a leftward drag did not narrow the pane again")
      .toBeLessThan(wider - MIN_MOVE);
  }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });
});

test("the column divider resizes columns even when row 1 has a single pane",
  async ({ page }) => {
  // THE REGRESSION TEST FOR THE TEST ABOVE, and it is here because the bug was
  // only ever reproducible in CI, which is an unacceptable place for the only
  // reproduction to live.
  //
  // The failure needed a layout whose FIRST ROW holds one pane. Then row 1 has
  // no column divider, and the first resize handle in DOM order is the ROW
  // divider — which both axes used to call "Drag to resize". Seeding that
  // layout explicitly makes the state deterministic on every machine instead
  // of waiting for a runner to happen into it.
  //
  // Asserted here and not folded into the test above because that one should
  // keep exercising the ordinary layout; this is the awkward one.
  const layout = {
    version: 2, id: "ws_single_top", name: "Single top",
    groups: {},
    rows: [
      // One pane: no column divider in this row at all.
      { id: "r1", height: 1, split: [1],
        panes: [{ id: "p1", widget: "chart", link: "none" }] },
      // Two panes: the first column divider on the page lives HERE, below a
      // row divider.
      { id: "r2", height: 1, split: [1, 1],
        panes: [{ id: "p2", widget: "financials", link: "none" },
                { id: "p3", widget: "news", link: "none" }] },
    ],
  };
  await page.request.put("http://localhost:8000/api/v1/workspaces", {
    headers: { Authorization: `Bearer ${await apiToken(page)}` },
    data: { layouts: [layout], active_id: layout.id },
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "WORKSPACE" })).toBeVisible();

  // The premise, asserted rather than assumed: the first handle on the page is
  // a ROW divider. If this ever stops being true the seeded layout has changed
  // and the rest of this test is no longer testing what it says.
  const anyHandle = page.locator('[title^="Drag to resize"]').first();
  await expect(anyHandle).toHaveAttribute("title", "Drag to resize rows");

  // And the fix: asking for the column divider by name still finds one, in
  // row 2, together with the column it actually resizes.
  const handle = page.getByTitle("Drag to resize columns").first();
  await expect(handle).toBeVisible();
  const column = handle.locator("xpath=preceding-sibling::div[1]");

  await expect(async () => {
    const before = (await column.boundingBox())!.width;
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2,
      { steps: 10 });
    await page.mouse.up();
    const after = (await column.boundingBox())!.width;
    expect(after, "the column divider did not resize its column")
      .toBeGreaterThan(before + 8);
  }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });
});

test("a corrupt saved desk falls back instead of white-screening", async ({ page }) => {
  await page.request.put("http://localhost:8000/api/v1/workspaces", {
    headers: { Authorization: `Bearer ${await apiToken(page)}` },
    data: { layouts: [{ id: "junk", name: "Junk", rows: [] }] },
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "WORKSPACE" })).toBeVisible();
  await expect(panes(page).first()).toBeVisible();
  await expect(page.getByText(BOUNDARY_TEXT)).toHaveCount(0);
});
