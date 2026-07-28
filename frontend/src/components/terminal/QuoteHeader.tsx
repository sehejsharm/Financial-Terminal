"use client";

import { ExternalLink } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { LiveNumber } from "@/components/LiveNumber";
import { useNow } from "@/lib/clock";
import { exchange, phaseLabel, sessionState } from "@/lib/marketSessions";
import { useQuote } from "@/lib/useQuote";
import type { Snapshot } from "@/lib/api";
import { fmtNum, humanNumber } from "@/lib/utils";

/**
 * The quote line.
 *
 * A terminal header should answer "where is this trading, and where is that
 * relative to everything I know about it" without a click. So alongside the
 * price: the bid/ask when the feed carries one, position within the 52-week
 * range, distance from the 50- and 200-day averages, volume against its own
 * average, and whether the listing exchange is actually open.
 *
 * Every figure is sourced — nothing is interpolated to fill a gap. Fields the
 * free providers don't cover render as "—" rather than a plausible number.
 */

function Field({ label, children, title, className = "" }: {
  label: string; children: React.ReactNode; title?: string; className?: string;
}) {
  return (
    <div className={`px-3 py-1.5 border-l border-line2 ${className}`} title={title}>
      <div className="label-xs whitespace-nowrap">{label}</div>
      <div className="num text-[12.5px] text-txt mt-0.5 whitespace-nowrap">{children}</div>
    </div>
  );
}

/** Where the price sits between two bounds, as a labelled track. */
function RangeBar({ low, high, at, label, lowLabel, highLabel }: {
  low?: number | null; high?: number | null; at?: number | null;
  label: string; lowLabel?: string; highLabel?: string;
}) {
  const ok = low != null && high != null && at != null && high > low;
  const pct = ok ? Math.min(100, Math.max(0, ((at - low) / (high - low)) * 100)) : 0;
  return (
    <div className="px-3 py-1.5 border-l border-line2 min-w-[176px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-xs whitespace-nowrap">{label}</span>
        {ok && (
          <span className="num text-[10px] text-mut"
                title="Position of the last price within this range">
            {fmtNum(pct, 0)}%
          </span>
        )}
      </div>
      {ok ? (
        <>
          <div className="hud-track h-[3px] w-full mt-1.5 relative">
            <div className="absolute inset-y-0 left-0 rounded-l"
                 style={{ width: `${pct}%`, background: "rgb(var(--c-amber) / 0.55)" }} />
            <div className="absolute top-[-2px] w-[2px] h-[7px] bg-amber rounded"
                 style={{ left: `calc(${pct}% - 1px)` }} />
          </div>
          <div className="flex justify-between num text-[9.5px] text-mut mt-0.5">
            <span>{lowLabel ?? fmtNum(low, 2)}</span>
            <span>{highLabel ?? fmtNum(high, 2)}</span>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-mut mt-1">—</div>
      )}
    </div>
  );
}

/** Exchange the listing trades on, inferred from the symbol suffix. */
function exchangeFor(ticker: string): string | null {
  const t = ticker.toUpperCase();
  if (t.endsWith(".NS") || t.endsWith(".BO") || t.startsWith("^NSE")
      || t.startsWith("^BSE") || t.startsWith("^CNX") || t === "^INDIAVIX") return "NSE";
  if (t.endsWith(".L")) return "LSE";
  if (t.endsWith(".T")) return "TSE";
  if (t.endsWith(".HK")) return "HKEX";
  if (t.endsWith(".AX")) return "ASX";
  if (t.includes("=X") || t.includes("=F")) return null;   // FX/futures: ~24h
  // Unsuffixed equities and the US indices are the NYSE/Nasdaq session.
  if (/^[A-Z.]{1,6}$/.test(t) || ["^GSPC", "^DJI", "^IXIC", "^RUT", "^VIX"].includes(t)) {
    return "NYSE";
  }
  return null;
}

export function QuoteHeader({
  ticker, name, snap, cur, fallbackPrice, fallbackCp,
  quoteAt, snapAt, snapBusy, onRefresh,
}: {
  ticker: string;
  name: string;
  snap: Snapshot | null;
  cur: string;
  fallbackPrice: number | null;
  fallbackCp: number | null;
  quoteAt: number | null;
  snapAt: number | null;
  snapBusy: boolean;
  onRefresh: () => void;
}) {
  const tick = useQuote(ticker);
  const now = useNow();

  const price = tick?.ltp ?? fallbackPrice;
  const cp = tick?.chgPct ?? fallbackCp;
  const up = cp != null && cp >= 0;

  const n = (k: string): number | null => {
    const v = snap?.[k as keyof Snapshot];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const prevClose = n("prev_close");
  const hi52 = n("fifty_two_high");
  const lo52 = n("fifty_two_low");
  const ma50 = n("fifty_day_avg");
  const ma200 = n("two_hundred_day_avg");
  const vol = tick?.vol ?? n("volume");
  const avgVol = n("avg_volume");
  const relVol = vol != null && avgVol != null && avgVol > 0 ? vol / avgVol : null;

  const bid = tick?.bid ?? null;
  const ask = tick?.ask ?? null;
  const spread = bid != null && ask != null && ask > bid ? ask - bid : null;

  const exCode = exchangeFor(ticker);
  const ex = exCode ? exchange(exCode) : undefined;
  const session = ex ? sessionState(ex, now) : null;

  /** Signed distance from a moving average, as a percentage of the average. */
  const vsMa = (ma: number | null) =>
    ma != null && price != null && ma > 0 ? ((price - ma) / ma) * 100 : null;

  const maCell = (ma: number | null, label: string) => {
    const d = vsMa(ma);
    return (
      <Field label={label}
             title={ma == null ? "Not covered by the free providers for this listing"
               : `Last price vs the ${label} — ${d! >= 0 ? "above" : "below"} by ${fmtNum(Math.abs(d!), 2)}%`}>
        {ma == null ? <span className="text-mut">—</span> : (
          <span className={d == null ? "" : d >= 0 ? "text-green" : "text-red"}>
            {d == null ? fmtNum(ma, 2) : `${d >= 0 ? "+" : ""}${fmtNum(d, 1)}%`}
          </span>
        )}
      </Field>
    );
  };

  return (
    <div data-testid="quote-header" className="hud mb-4 overflow-hidden">
      {/* ── identity + price ── */}
      <div className="flex flex-wrap items-stretch">
        <div className="px-3.5 py-2.5 flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-amber text-[11px] uppercase tracking-[0.18em]">{ticker}</span>
            {session && (
              <span className={`text-[9.5px] uppercase tracking-wider px-1.5 py-[1px] rounded border ${
                session.phase === "open"
                  ? "text-green border-green/50"
                  : session.phase === "break" || session.phase === "pre"
                    ? "text-amber border-amber/50"
                    : "text-mut border-line2"}`}
                    title={`${ex!.city} — ${phaseLabel(session)}. Public holidays are not modelled.`}>
                {session.phase === "open" ? "OPEN" : session.phase === "closed" ? "CLOSED" : session.phase.toUpperCase()}
              </span>
            )}
            {tick?.stale && (
              <span className="text-[9.5px] uppercase tracking-wider text-amber border border-amber/50 rounded px-1.5 py-[1px]"
                    title="The feed marked this quote stale — it is the last value received, not a live one.">
                stale
              </span>
            )}
          </div>
          <div className="text-lg font-bold tracking-tight truncate mt-0.5" title={name}>{name}</div>
          <div className="text-mut text-[11px]">
            {(snap?.sector as string) || "—"} · {(snap?.industry as string) || "—"}
          </div>
        </div>

        <div className="px-4 py-2.5 border-l border-line2 flex flex-col justify-center min-w-[190px]">
          <div className="num text-[27px] leading-none text-txt">
            {price != null
              ? <LiveNumber symbol={ticker} field="ltp" format="price" ccy={cur} />
              : <span className="text-mut">—</span>}
          </div>
          <div className={`num text-[13px] mt-1 ${cp == null ? "text-mut" : up ? "text-green" : "text-red"}`}>
            {cp != null ? (
              <>
                {up ? "▲" : "▼"}{" "}
                <LiveNumber symbol={ticker} field="chgPct" format="pct" showDelta />
                {tick?.chg != null && (
                  <span className="text-mut ml-2">{fmtNum(Math.abs(tick.chg), 2)}</span>
                )}
              </>
            ) : "—"}
          </div>
        </div>
      </div>

      {/* ── the stat strip ── */}
      <div className="flex flex-wrap items-stretch border-t border-line2">
        <Field label="Prev close" title="Previous session's closing price">
          {prevClose != null ? fmtNum(prevClose, 2) : <span className="text-mut">—</span>}
        </Field>

        <Field label="Bid / Ask"
               title={spread != null
                 ? `Spread ${fmtNum(spread, 2)} (${fmtNum((spread / (ask || 1)) * 100, 3)}% of ask)`
                 : "The free quote feed does not publish a bid/ask for this listing"}>
          {bid != null && ask != null
            ? <>{fmtNum(bid, 2)} <span className="text-mut">/</span> {fmtNum(ask, 2)}</>
            : <span className="text-mut">—</span>}
        </Field>

        <Field label="Volume"
               title={relVol != null
                 ? `${humanNumber(vol!)} traded vs a ${humanNumber(avgVol!)} average — ${fmtNum(relVol, 2)}x normal`
                 : "Volume or its average is not covered for this listing"}>
          {vol != null ? (
            <>
              {humanNumber(vol)}
              {relVol != null && (
                <span className={`ml-1.5 ${relVol >= 1.5 ? "text-amber" : "text-mut"}`}>
                  {fmtNum(relVol, 2)}x
                </span>
              )}
            </>
          ) : <span className="text-mut">—</span>}
        </Field>

        {maCell(ma50, "vs 50d")}
        {maCell(ma200, "vs 200d")}

        <Field label="Market cap">
          {snap?.market_cap != null
            ? humanNumber(snap.market_cap as number, cur)
            : <span className="text-mut">—</span>}
        </Field>

        <RangeBar label="52-week range" low={lo52} high={hi52} at={price} />

        <div className="flex-1 min-w-[150px] flex items-center justify-end gap-3 px-3 py-1.5">
          <div className="flex flex-col items-end gap-0.5">
            <DataAge at={quoteAt} prefix="Quote" />
            <DataAge at={snapAt} prefix="Fundamentals" onRefresh={onRefresh} busy={snapBusy} />
          </div>
          <a href={`/tearsheet?t=${encodeURIComponent(ticker)}`} target="_blank" rel="noreferrer"
             className="text-[10.5px] text-mut hover:text-amber flex items-center gap-1 shrink-0"
             title="Print-ready one-page tear sheet">
            Tear sheet <ExternalLink size={10} />
          </a>
        </div>
      </div>
    </div>
  );
}
