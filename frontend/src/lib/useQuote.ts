"use client";

import { useCallback, useEffect } from "react";
import { useSyncExternalStore } from "react";

import { quoteStore, type StreamStatus, type Tick } from "@/lib/quoteStore";

/** Subscribe ONE cell to ONE symbol. Ref-counts the socket subscription over
 *  the component's lifetime and re-renders only when THIS symbol's tick
 *  changes (subscription-per-cell — no table-wide re-render). */
export function useQuote(symbol: string | null | undefined): Tick | undefined {
  const sym = symbol ? symbol.toUpperCase() : "";

  useEffect(() => {
    if (!sym) return;
    return quoteStore.subscribe([sym]);
  }, [sym]);

  const subscribe = useCallback(
    (cb: () => void) => (sym ? quoteStore.subscribeTick(sym, cb) : () => {}),
    [sym],
  );
  const getSnapshot = useCallback(() => (sym ? quoteStore.getTick(sym) : undefined), [sym]);
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/** Bulk-subscribe a table/page to many symbols at once (cells still read
 *  individual values via useQuote). Ref-counted; auto-unsub on unmount. */
export function useQuotes(symbols: string[]): void {
  const key = Array.from(new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean)))
    .sort().join(",");
  useEffect(() => {
    if (!key) return;
    return quoteStore.subscribe(key.split(","));
  }, [key]);
}

/** Real socket state for the LIVE/RECONNECTING/STALE/CLOSED badge. */
export function useStreamStatus(): { status: StreamStatus; marketOpen: boolean } {
  const status = useSyncExternalStore(
    (cb) => quoteStore.subscribeStatus(cb),
    () => quoteStore.status,
    () => "connecting" as StreamStatus,
  );
  return { status, marketOpen: quoteStore.marketOpen };
}
