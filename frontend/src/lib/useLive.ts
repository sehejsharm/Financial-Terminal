"use client";

/**
 * useLive — polling data hook with visibility-aware pause.
 *
 * The app previously fetched once on mount and never again, while the header
 * showed a "LIVE" badge. This hook makes panels actually live:
 *   - loads immediately, then re-loads every `intervalMs`
 *   - pauses when the tab is hidden (document.visibilityState) so background
 *     tabs don't burn backend capacity; on return it refreshes immediately
 *     if a tick was missed
 *   - exposes { data, error, busy, updatedAt, refresh } — `refresh()` is the
 *     manual force-revalidate for the panel's refresh button
 *
 * Active pollers register in a tiny module-level registry that the Shell
 * header subscribes to, so the LIVE badge reflects reality (polling running
 * vs static page) instead of being decorative.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── live-status registry (for the honest header badge) ─────────────────────
type StatusListener = () => void;
let activePollers = 0;
let lastTick = 0;
const listeners = new Set<StatusListener>();

function notify() { listeners.forEach((l) => l()); }
function pollerStarted() { activePollers++; notify(); }
function pollerStopped() { activePollers = Math.max(0, activePollers - 1); notify(); }
function ticked() { lastTick = Date.now(); notify(); }

export function useLiveStatus(): { polling: boolean; lastTick: number } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return { polling: activePollers > 0, lastTick };
}

// ── the hook ────────────────────────────────────────────────────────────────

/** How long a single poll may take before it is abandoned.
 *
 *  Without this, a request that never settles does more than hang a spinner:
 *  `inFlightRef` never clears, so every subsequent tick returns early and the
 *  poller is dead for the rest of the session. The surface does not recover
 *  until the user reloads the page. Matches useAsync's deadline so the two
 *  hooks fail the same way. */
export const LIVE_TIMEOUT_MS = 25_000;

export function useLive<T>(
  loader: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
  opts: { timeoutMs?: number } = {},
): {
  data: T | null;
  error: string | null;
  busy: boolean;
  updatedAt: number | null;
  refresh: () => void;
} {
  const { timeoutMs = LIVE_TIMEOUT_MS } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Keep the latest loader without retriggering the effect on every render.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const lastRunRef = useRef(0);
  const inFlightRef = useRef(false);

  const run = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    lastRunRef.current = Date.now();
    setBusy(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      // The loader is raced, not cancelled — it may still be in flight after
      // we give up on it. That is fine: whatever it eventually does, this
      // poll has already released the lock so the next tick can run.
      const d = await Promise.race([
        loaderRef.current(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("__mb_timeout__")), timeoutMs);
        }),
      ]);
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
      ticked();
    } catch (e: any) {
      setError(
        e?.message === "__mb_timeout__"
          ? `Gave up after ${Math.round(timeoutMs / 1000)}s. The data provider `
            + "is slow or unreachable — this will retry on the next tick."
          : e?.detail || e?.message || "Failed to load",
      );
    } finally {
      if (timer) clearTimeout(timer);
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [timeoutMs]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (timer) return;
      timer = setInterval(run, intervalMs);
      pollerStarted();
    }
    function stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      pollerStopped();
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        // Missed a tick while hidden? Catch up immediately.
        if (Date.now() - lastRunRef.current >= intervalMs) run();
        start();
      }
    }

    setData(null);
    setUpdatedAt(null);
    run();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, run, ...deps]);

  return { data, error, busy, updatedAt, refresh: run };
}
