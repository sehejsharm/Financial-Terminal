import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/**
 * Mock-tick test: intercept the /stream WebSocket, act as the server, and
 * assert a <LiveNumber> cell actually re-renders when a delta arrives — the
 * proof that the streaming spine moves numbers, with zero dependence on live
 * market data.
 */
test("dashboard index tile updates when a mock tick arrives", async ({ page }) => {
  test.setTimeout(120_000);

  // Intercept the socket BEFORE the dashboard mounts and opens it.
  await page.routeWebSocket(/\/api\/v1\/stream/, (ws) => {
    // Announce an open market so the tile streams (not CLOSED).
    ws.send(JSON.stringify({ t: "stat", ts: Date.now(), d: { marketOpen: true } }));
    ws.onMessage((raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.op === "sub") {
        for (const s of msg.symbols) {
          // initial snapshot
          ws.send(JSON.stringify({ t: "snap", d: [{ s, ltp: 100.0, chgPct: 0.5, ts: 1 }] }));
        }
        if (msg.symbols.includes("^NSEI")) {
          // a live delta a beat later — distinctive value we can assert on
          setTimeout(() => ws.send(JSON.stringify({
            t: "px", d: [{ s: "^NSEI", ltp: 24680.55, chgPct: 1.23, ts: 2 }],
          })), 700);
        }
      }
    });
  });

  await login(page);
  await page.goto("/");

  // NIFTY 50 tile paints the snapshot first. Targeted by test id rather than
  // by walking up from the label text: that coupled the assertion to the
  // tile's exact DOM shape and broke the moment the tile was redesigned.
  const nifty = page.getByTestId("tile-^NSEI");
  await expect(nifty.getByText("100.00")).toBeVisible({ timeout: 30_000 });
  // …then the mock delta moves it — the number changed live.
  await expect(page.getByText("24,680.55")).toBeVisible({ timeout: 30_000 });
});
