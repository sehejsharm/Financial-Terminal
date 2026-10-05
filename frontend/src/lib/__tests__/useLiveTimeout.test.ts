// @vitest-environment jsdom
//
// Scoped to this file: the rest of the suite runs in `node` and should stay
// there — a DOM is only needed because this exercises a React hook.

/** useLive must not be able to hang forever.
 *
 *  A poll that never settles used to do more than spin: `inFlightRef` never
 *  cleared, so every later tick hit the `if (inFlightRef.current) return`
 *  guard and the poller was dead for the rest of the session. The surface
 *  only recovered on a full page reload, and nothing on screen said why.
 *
 *  useLive drives the portfolio summary, the terminal quote header and the
 *  alerts list — three of the surfaces a user is most likely to leave open.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIVE_TIMEOUT_MS, useLive } from "../useLive";

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

/** A promise that never settles — the hung provider. */
const neverSettles = () => new Promise<never>(() => {});

describe("useLive timeout", () => {
  it("gives up on a hung request instead of spinning forever", async () => {
    const { result } = renderHook(() =>
      useLive(neverSettles, 60_000, [], { timeoutMs: 1_000 }));

    expect(result.current.busy).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.error).toMatch(/Gave up after 1s/);
  });

  it("names the deadline and says it will retry", async () => {
    // The message has to tell the user what happens next, or the only move
    // they can think of is reloading the page.
    const { result } = renderHook(() =>
      useLive(neverSettles, 60_000, [], { timeoutMs: 1_000 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    await waitFor(() =>
      expect(result.current.error).toMatch(/slow or unreachable/));
    expect(result.current.error).toMatch(/retry on the next tick/);
  });

  it("RELEASES the in-flight lock so polling survives a hang", async () => {
    // The real bug. One hung request used to kill the poller permanently.
    let calls = 0;
    const loader = () => {
      calls += 1;
      return calls === 1 ? neverSettles() : Promise.resolve({ ok: calls });
    };

    const { result } = renderHook(() =>
      useLive(loader, 2_000, [], { timeoutMs: 1_000 }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    await waitFor(() => expect(result.current.error).toBeTruthy());

    // Next tick must actually run.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    await waitFor(() => expect(result.current.data).toEqual({ ok: 2 }));
    expect(result.current.error).toBeNull();
  });

  it("a fast loader is unaffected", async () => {
    const { result } = renderHook(() =>
      useLive(async () => ({ v: 1 }), 60_000, [], { timeoutMs: 5_000 }));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("keeps the last good data when a later poll fails", async () => {
    // Blanking the screen on a transient failure throws away information the
    // user can still act on; the error line carries the bad news instead.
    let calls = 0;
    const loader = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ v: 1 }) : Promise.reject(new Error("boom"));
    };
    const { result } = renderHook(() =>
      useLive(loader, 1_000, [], { timeoutMs: 5_000 }));

    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    await waitFor(() => expect(result.current.error).toMatch(/boom/));
    expect(result.current.data).toEqual({ v: 1 });
  });

  it("defaults to a deadline rather than none at all", () => {
    expect(LIVE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LIVE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
