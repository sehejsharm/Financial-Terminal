"use client";

import { useEffect, useRef, useState } from "react";

import { useQuote } from "@/lib/useQuote";
import { fmtNum, fmtPct, humanNumber } from "@/lib/utils";

type Field = "ltp" | "chg" | "chgPct" | "bid" | "ask" | "vol";
type Format = "price" | "pct" | "num" | "human";

/**
 * A single streaming numeric cell.
 *  - streaming mode: pass `symbol` + `field`; reads from the QuoteStore.
 *  - derived mode: pass `value` directly (e.g. live P&L computed from a tick).
 * On each change it flashes green/red (via var-backed classes, so the
 * colorblind toggle remaps it automatically), optionally shows a bps pill,
 * and announces politely for screen readers. Paint is rAF-batched in the
 * store, so many LiveNumbers flush together rather than thrashing React.
 */
export function LiveNumber({
  symbol, field = "ltp", value, format = "price",
  ccy = "", digits, showDelta = false, flash = true,
  ariaLabel, className = "",
}: {
  symbol?: string;
  field?: Field;
  value?: number | null;   // derived mode
  format?: Format;
  ccy?: string;
  digits?: number;
  showDelta?: boolean;
  flash?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const tick = useQuote(symbol && value === undefined ? symbol : null);
  const raw = value !== undefined ? value : (tick ? (tick[field] as number | null) : null);
  const bps = tick?.chgPct != null ? Math.round(tick.chgPct * 100) : null;

  const [dir, setDir] = useState<0 | 1 | -1>(0);
  const prevRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (raw == null || !flash) return;
    const prev = prevRef.current;
    if (prev != null && raw !== prev) {
      setDir(raw > prev ? 1 : -1);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setDir(0), 600);
    }
    prevRef.current = raw;
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [raw, flash]);

  const text = fmt(raw, format, ccy, digits);
  const flashCls = dir === 1 ? "live-flash-up" : dir === -1 ? "live-flash-down" : "";
  // Seeded (REST/cache) values render slightly dimmed until the first live
  // tick, so users can tell fresh-from-socket from last-known-good.
  const seededCls = tick?.seeded && value === undefined ? "opacity-70" : "";

  return (
    <span
      className={`num tabular-nums transition-colors ${flashCls} ${seededCls} ${className}`}
      aria-live="polite"
      aria-atomic="true"
      aria-label={ariaLabel}
    >
      {text}
      {showDelta && bps != null && (
        <span className={`ml-1 text-[9px] px-1 rounded ${bps >= 0 ? "text-green" : "text-red"}`}>
          {bps >= 0 ? "+" : ""}{bps}bps
        </span>
      )}
    </span>
  );
}

function fmt(v: number | null, format: Format, ccy: string, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (format) {
    case "pct": return fmtPct(v, digits ?? 2);
    case "human": return humanNumber(v, ccy);
    case "num": return fmtNum(v, digits ?? 0);
    case "price":
    default: return `${ccy}${fmtNum(v, digits ?? 2)}`;
  }
}
