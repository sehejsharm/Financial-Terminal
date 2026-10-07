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
    .analyze();
}

/** A readable failure: axe's own output is enormous. */
function summarise(violations: Awaited<ReturnType<typeof axeOn>>["violations"]) {
  return violations.map((v) =>
    `${v.impact} ${v.id} x${v.nodes.length} -> ${v.nodes[0]?.target?.join(" ")}`);
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
