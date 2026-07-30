import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * ALERTS' pre-arm validation.
 *
 * The form accepted any number for any condition and said nothing. Two silent
 * failures followed. "Price < 100" on a stock at 1,425 arms happily and never
 * fires — the user finds out by not being told about the move they cared
 * about. "Price < 2,000" on the same stock is ALREADY true, so it fires on the
 * next evaluation and deactivates: the alert is consumed at the moment of
 * creation, which reads as success.
 *
 * The live quote was already available. These pin that it is now used.
 */

// The draft flow does a quote fetch per keystroke-commit, so give the whole
// test room: a 60s expect inside a 60s test dies before the assertion settles.
test.setTimeout(120_000);

const PRICE = 1425.6;

async function open(page: Page, alerts: unknown[] = []) {
  await login(page);
  await page.route("**/api/v1/alerts**", (r) => {
    if (r.request().method() !== "GET") return r.fulfill({ json: { ok: true } });
    r.fulfill({ json: { alerts, events: [] } });
  });
  await page.route("**/api/v1/market/quote/**", (r) => r.fulfill({ json: {
    symbol: "RELIANCE.NS", price: PRICE, prev_close: 1440.2, change_pct: -1.01,
    currency: "INR",
  } }));
  await page.route("**/api/v1/market/snapshot/**", (r) => r.fulfill({ json: {
    name: "Reliance Industries Ltd", price: PRICE, currency: "INR",
    trailing_pe: 27.1,
  } }));
  // The ticker box autocompletes; unstubbed these reach the real providers and
  // the 60s socket timeout swallows the whole test.
  await page.route("**/api/v1/market/search**", (r) => r.fulfill({ json: [
    { symbol: "RELIANCE.NS", name: "Reliance Industries Ltd" },
  ] }));
  await page.route("**/api/v1/market/resolve**", (r) => r.fulfill({ json: {
    status: "resolved", match: { symbol: "RELIANCE.NS", name: "Reliance Industries Ltd" },
  } }));
  await page.goto("/alerts");
  // Wait for the form to be interactive before any test touches it. The first
  // hit pays Next's route compile, and paying it inside a 15s assertion
  // instead of the test budget is what made this spec flaky.
  await expect(page.getByTestId("alert-form")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Create alert" }))
    .toBeVisible({ timeout: 60_000 });
}

/** Fill the create form. The ticker input commits on Enter. */
async function draft(page: Page, opts: { op: "<" | ">"; value: string; kind?: string }) {
  // Scoped to the create form: the page also has the delivery panel's inputs,
  // and label association on the wrapping <label> elements is unreliable.
  const form = page.getByTestId("alert-form");
  if (opts.kind) {
    // Assert the selection landed: fired before hydration settles, the change
    // event is dropped and the form silently stays on the default condition.
    const kindSelect = form.locator("select").first();
    await expect(kindSelect).toBeEnabled();
    await kindSelect.selectOption(opts.kind);
    await expect(kindSelect).toHaveValue(opts.kind);
  }
  const ticker = form.getByPlaceholder("RELIANCE.NS");
  await ticker.fill("RELIANCE.NS");
  await ticker.press("Enter");
  await form.locator("select").last().selectOption(opts.op);
  await form.locator('input[type="number"]').last().fill(opts.value);
}

test("ALERTS refuses a condition that is ALREADY true", async ({ page }) => {
  // It would fire on the next evaluation and deactivate — consuming the alert
  // rather than watching for anything.
  await open(page);
  await draft(page, { op: "<", value: "2000" });
  await expect(page.getByText(/ALREADY true/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/consumes the alert rather than watching/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create alert" })).toBeDisabled();
});

test("ALERTS warns about a threshold no ordinary move will reach", async ({ page }) => {
  await open(page);
  await draft(page, { op: "<", value: "10" });
  await expect(page.getByText(/away from the current/)).toBeVisible();
  await expect(page.getByText(/check the number is the one you meant/)).toBeVisible();
  // A warning is information, not a veto — the user may mean it.
  await expect(page.getByRole("button", { name: "Create alert" })).toBeEnabled();
});

test("ALERTS shows how far a good threshold is from firing", async ({ page }) => {
  await open(page);
  await draft(page, { op: "<", value: "1200" });
  await expect(page.getByText(/needs to move down/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Create alert" })).toBeEnabled();
});

test("ALERTS shows the current value it is checking against", async ({ page }) => {
  await open(page);
  await draft(page, { op: "<", value: "1200" });
  await expect(page.getByText(/Price now: 1,425\.60/)).toBeVisible({ timeout: 30_000 });
});

test("ALERTS catches a units mistake on volume spike", async ({ page }) => {
  // 200 meaning "200% of average" is 200x, which never happens.
  await open(page);
  await draft(page, { kind: "volume_spike", op: ">", value: "200" });
  await expect(page.getByText(/outside the sensible range/))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/A MULTIPLE, not a percentage/)).toBeVisible();
});

test("ALERTS says an alert is a tripwire, not a standing monitor", async ({ page }) => {
  await open(page, [
    { id: "1", kind: "price", ticker: "RELIANCE.NS", op: "<", value: 1200,
      active: true, created_at: "2026-06-01T00:00:00Z", triggered_at: null },
  ]);
  await expect(page.getByText(/fires ONCE and then deactivates/))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/a tripwire, not a standing monitor/)).toBeVisible();
});

test("ALERTS says a move inside the evaluation window is never seen", async ({ page }) => {
  // With no alerts the note explains the setup instead, which is right — so
  // this needs one to exist.
  await open(page, [
    { id: "1", kind: "price", ticker: "RELIANCE.NS", op: "<", value: 1200,
      active: true, created_at: "2026-06-01T00:00:00Z", triggered_at: null },
  ]);
  await expect(page.getByText(/reverses inside that window is never seen/))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/not necessarily one you could have traded at/))
    .toBeVisible();
});

test("ALERTS still requires a threshold before it says anything else", async ({ page }) => {
  await open(page);
  const ticker = page.getByPlaceholder("RELIANCE.NS");
  await expect(ticker).toBeVisible({ timeout: 30_000 });
  // No threshold typed: no verdict either way, and no false reassurance.
  await expect(page.getByText(/ALREADY true/)).toHaveCount(0);
  await expect(page.getByText(/needs to move/)).toHaveCount(0);
});
