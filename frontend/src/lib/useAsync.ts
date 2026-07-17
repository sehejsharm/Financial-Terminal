"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Standard data-fetching state machine for ticker-keyed panels:
 * loading / error / data, with a stale-response guard (only the latest
 * request may apply) and a retry() that reruns the current request.
 *
 * Replaces the recurring ad-hoc pattern where a `.catch(() => setData(null))`
 * left panels stuck on "Loading…" forever or silently rendered an all-dash
 * table after a provider failure.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList,
): { data: T | null; error: string | null; busy: boolean; retry: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const reqRef = useRef(0);

  useEffect(() => {
    const reqId = ++reqRef.current;
    setBusy(true); setError(null); setData(null);
    fn()
      .then((v) => { if (reqRef.current === reqId) setData(v); })
      .catch((e: any) => {
        if (reqRef.current === reqId) {
          setError(e?.detail || e?.message || "Failed to load.");
        }
      })
      .finally(() => { if (reqRef.current === reqId) setBusy(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, epoch]);

  const retry = useCallback(() => setEpoch((n) => n + 1), []);
  return { data, error, busy, retry };
}

/** Standard error panel with a retry button — pair with useAsync. */
export function errorPanelProps(error: string, retry: () => void) {
  return { error, retry };
}
