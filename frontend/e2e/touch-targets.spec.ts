import { expect, test } from "@playwright/test";

import { apiToken, signIn } from "./helpers";

/**
 * Icon-only controls must be tappable, not just visible.
 *
 * WCAG 2.2 (2.5.8, AA) asks for 24x24 CSS pixels. Measured across every route
 * at 360px, this app had controls at 11x11, 14x14, 19x20 and 23x23 — and the
 * smallest two were the destructive ones (delete portfolio, delete layout). On
 * a phone that is a coin flip, and the coin decides whether a portfolio is
 * deleted.
 *
 * The fix expands the TAP area with a pseudo-element rather than resizing the
 * icon, because these controls sit in dense rows where real padding reflows
 * the row. That means getBoundingClientRect STILL reports the small size — it
 * measures the element, not the ::after — so a bounding-box audit cannot
 * verify the fix at all.
 *
 * Hence this: click 9px off-centre, outside the visual icon but inside the
 * 24px target, and assert the control actually fired. That is the only thing
 * that proves a user's thumb would have worked.
 */
const PHONE = { width: 360, height: 780 };

test.use({ viewport: PHONE });

test("the data-age refresh control clears the 24px floor on its own box",
  async ({ page }) => {
    // This one was fixed with min-w/min-h rather than a pseudo-element, so it
    // IS measurable — it was 23x23, one pixel short of the floor.
    await signIn(page);
    await page.goto("/");
    const refresh = page.getByRole("button",
      { name: "Refresh now, bypassing the cache" }).first();
    await expect(refresh).toBeVisible();
    const box = (await refresh.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
  });

test("a hit-target control responds to a tap outside its icon", async ({ page }) => {
  await signIn(page);
  await page.goto("/portfolio");

  // Seeded through the API so the test actually runs. It skipped when first
  // written, and a skipped test proves nothing about a destructive control
  // being mis-tappable.
  const auth = { Authorization: `Bearer ${await apiToken(page)}` };
  const created = await page.request.post(
    "http://localhost:8000/api/v1/portfolio/create",
    { headers: auth, data: { name: `tap-target-${Date.now()}` } });
  const id = (await created.json()).id as string;
  // Removed again at the end. Without this the suite's shared data dir grows
  // a portfolio per run, the sidebar list lengthens, and the row this test
  // clicks moves — which showed up as the test passing alone and failing in
  // sequence.
  await page.reload();

  try {
  const del = page.getByRole("button", { name: "Delete portfolio" }).first();
  await expect(del).toBeVisible();

  // The handler calls window.confirm, so the confirm firing IS the proof the
  // click landed — and dismissing it means this test never actually deletes
  // anything. Asserting on a visible dialog does not work: Playwright
  // auto-dismisses native dialogs, so nothing is ever on screen to find.
  let confirmed = "";
  page.on("dialog", (d) => { confirmed = d.message(); void d.dismiss(); });

  const box = (await del.boundingBox())!;
  // The visual icon is ~11px, so the element box is ~11px. Nine pixels out
  // from centre is outside the icon and inside the expanded 24px target —
  // a tap that MISSED before this fix and connects now.
  await page.mouse.click(box.x + box.width / 2 + 9, box.y + box.height / 2);

  await expect.poll(() => confirmed, { timeout: 5000 })
    .toContain("Delete portfolio");
  } finally {
    await page.request.delete(
      `http://localhost:8000/api/v1/portfolio/${id}`, { headers: auth });
  }
});

test("every icon-only control has an accessible name", async ({ page }) => {
  // An icon with no name is unusable with a screen reader and unlabelled in
  // every automated audit. Checked app-wide rather than per page because the
  // offenders are shared components.
  await signIn(page);
  for (const route of ["/", "/portfolio", "/alerts", "/workspace"]) {
    await page.goto(route);
    await page.waitForTimeout(1200);
    const nameless = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll("button,[role=button]").forEach((el) => {
        const e = el as HTMLElement;
        const b = e.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) return;
        const named = (e.getAttribute("aria-label") || e.getAttribute("title")
          || (e.textContent || "").trim());
        if (!named) out.push(e.outerHTML.slice(0, 80));
      });
      return [...new Set(out)];
    });
    expect(nameless, `unnamed controls on ${route}`).toEqual([]);
  }
});
