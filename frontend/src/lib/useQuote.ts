"use client";

import { useCallback, useEffect, useReducer } from "react";
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

/** Live ticks for MANY symbols, for a cross-row aggregate (e.g. portfolio
 *  totals). Ref-counts subscriptions and forces at most ONE re-render per
 *  animation frame no matter how many of the symbols tick — so a live total
 *  updates smoothly without re-rendering per symbol. Returns a fresh Map each
 *  render (not a useSyncExternalStore snapshot, so identity churn is fine). */
export function useLiveTicks(symbols: string[]): Map<string, Tick> {
  const syms = Array.from(new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean)));
  const key = syms.slice().sort().join(",");
  const [, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    const unsubSocket = quoteStore.subscribe(list);
    let scheduled = false;
    const onTick = () => {
      if (scheduled) return;
      scheduled = true;
      const run = () => { scheduled = false; force(); };
      if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(run);
      else setTimeout(run, 100);
    };
    const unsubTicks = list.map((s) => quoteStore.subscribeTick(s, onTick));
    return () => { unsubSocket(); unsubTicks.forEach((u) => u()); };
  }, [key]);

  const map = new Map<string, Tick>();
  for (const s of syms) {
    const t = quoteStore.getTick(s);
    if (t) map.set(s, t);
  }
  return map;
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
