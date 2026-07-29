"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";

/**
 * Standard data-fetching state machine for panels: loading / error / data,
 * with a stale-response guard (only the latest request may apply) and a
 * retry() that reruns the current request.
 *
 * Replaces the recurring ad-hoc pattern where a `.catch(() => setData(null))`
 * left panels stuck on "Loading…" forever or silently rendered an all-dash
 * table after a provider failure.
 *
 * Two guarantees were added after the Macro → Sectors board was found
 * spinning indefinitely with no timeout and no error state:
 *
 *   * There is always a deadline. A panel cannot wait forever, and a caller
 *     cannot opt out of that — only change how long it is.
 *   * A failure is attributed. `serverFault` distinguishes "the backend
 *     returned 502" from "your network is down", because telling someone to
 *     check their connection when the server is broken sends them to debug
 *     the one thing that works.
 */

//: A panel that hasn't answered in this long is a failure, not a slow load.
export const DEFAULT_TIMEOUT_MS = 25_000;

export type AsyncResult<T> = {
  data: T | null;
  error: string | null;
  busy: boolean;
  /** The failure was the backend's, not the browser's. */
  serverFault: boolean;
  /** Epoch ms of the last successful load — for "as of" labels. */
  fetchedAt: number | null;
  retry: () => void;
};

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList,
  opts: { timeoutMs?: number; enabled?: boolean } = {},
): AsyncResult<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverFault, setServerFault] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(enabled);
  const [epoch, setEpoch] = useState(0);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const reqId = ++reqRef.current;
    setBusy(true); setError(null); setData(null); setServerFault(false);

    // The API layer has its own per-request timeout, but a panel that
    // chains several calls, or awaits something other than fetch, needs a
    // ceiling of its own. This is the backstop that makes "hangs forever"
    // unreachable regardless of what `fn` does.
    const timer = setTimeout(() => {
      if (reqRef.current !== reqId) return;
      setError(`Gave up after ${Math.round(timeoutMs / 1000)}s. The data `
        + "provider is slow or unreachable — retry in a moment.");
      setServerFault(true);
      setBusy(false);
      reqRef.current += 1;      // any late response is now ignored
    }, timeoutMs);

    fn()
      .then((v) => {
        if (reqRef.current !== reqId) return;
        setData(v);
        setFetchedAt(Date.now());
      })
      .catch((e: any) => {
        if (reqRef.current !== reqId) return;
        setError(e?.detail || e?.message || "Failed to load.");
        setServerFault(e instanceof ApiError ? e.serverFault : false);
      })
      .finally(() => {
        if (reqRef.current !== reqId) return;
        clearTimeout(timer);
        setBusy(false);
      });

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, epoch, enabled, timeoutMs]);

  const retry = useCallback(() => setEpoch((n) => n + 1), []);
  return { data, error, busy, serverFault, fetchedAt, retry };
}

/** Standard error panel with a retry button — pair with useAsync. */
export function errorPanelProps(error: string, retry: () => void) {
  return { error, retry };
}
