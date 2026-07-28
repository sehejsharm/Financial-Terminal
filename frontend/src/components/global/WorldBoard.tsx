"use client";

import Link from "next/link";
import { useMemo } from "react";

import { LiveNumber } from "@/components/LiveNumber";
import { useNow } from "@/lib/clock";
import { crossMatrix, fxDigits, FX_CCYS } from "@/lib/fxCross";
import { instrument } from "@/lib/instruments";
import { exchange, fmtCountdown, sessionState } from "@/lib/marketSessions";
import { useLiveTicks, useQuote, useQuotes } from "@/lib/useQuote";
import { curForTicker, fmtNum } from "@/lib/utils";

/**
 * The Global board.
 *
 * The old page was three tabs of identical tiles. These are the three things
 * a cross-asset screen should actually answer at a glance: which venues are
 * trading right now, how each region is moving relative to the others, and
 * what any currency is worth in any other.
 */

// ── who's trading right now ───────────────────────────────────────────────

const VENUES = ["NSE", "HKEX", "TSE", "SGX", "ASX", "LSE", "NYSE"];

export function SessionStrip() {
  const now = useNow();
  const states = useMemo(
    () => VENUES.map((c) => sessionState(exchange(c)!, now)), [now]);
  const open = states.filter((s) => s.phase === "open").length;

  return (
    <div className="hud mb-5 flex flex-wrap items-stretch overflow-hidden">
      <div className="px-3.5 py-2 flex flex-col justify-center min-w-[132px]">
        <div className="label-xs">Trading now</div>
        <div className="num text-[15px] text-txt mt-0.5">
          {open}<span className="text-mut text-[11px]">/{states.length}</span>
        </div>
      </div>
      {states.map((s) => (
        <div key={s.code}
             title={`${s.city} — ${s.localTime} local. Public holidays are not modelled.`}
             className="px-3 py-2 border-l border-line2 flex-1 min-w-[96px]">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${
              s.phase === "open" ? "bg-green animate-pulse"
                : s.phase === "break" || s.phase === "pre" ? "bg-amber" : "bg-line2"}`} />
            <span className="text-[10.5px] tracking-[0.1em] font-bold text-txt">{s.code}</span>
          </div>
          <div className="num text-[12px] text-txt mt-0.5">{s.localTime}</div>
          <div className={`text-[9.5px] uppercase tracking-wider ${
            s.phase === "open" ? "text-green" : "text-mut"}`}>
            {s.phase === "open" ? `closes ${fmtCountdown(s.minutesToChange)}`
              : s.phase === "pre" ? `opens ${fmtCountdown(s.minutesToChange)}`
              : s.phase === "break" ? "lunch" : "closed"}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── regional heatmap ──────────────────────────────────────────────────────

/** Background for a move, saturating at ±2% — beyond that the exact size
 *  matters less than the direction, and a full cell reads faster. */
function heatBg(cp: number | null): string {
  if (cp == null) return "transparent";
  const a = Math.min(1, Math.abs(cp) / 2);
  return cp >= 0
    ? `rgb(var(--c-green) / ${(0.08 + a * 0.42).toFixed(3)})`
    : `rgb(var(--c-red) / ${(0.08 + a * 0.42).toFixed(3)})`;
}

function HeatCell({ sym }: { sym: string }) {
  const meta = instrument(sym);
  const tick = useQuote(sym);
  const cp = tick?.chgPct ?? null;
  const cur = curForTicker(sym, tick?.ccy);

  return (
    <Link href={`/terminal?t=${encodeURIComponent(sym)}`}
          title={`${meta.label} — open in Terminal`}
          className="hud px-2.5 py-2 flex flex-col justify-between min-h-[74px] relative overflow-hidden">
      <span aria-hidden className="absolute inset-0 pointer-events-none transition-colors duration-500"
            style={{ background: heatBg(cp) }} />
      <span className="label-xs truncate relative">{meta.short}</span>
      <span className="relative">
        <span className="num text-[14px] text-txt block leading-none">
          {tick?.ltp != null
            ? <LiveNumber value={tick.ltp} format="price" ccy={cur} />
            : <span className="text-mut">···</span>}
        </span>
        <span className={`num text-[11.5px] ${
          cp == null ? "text-mut" : cp >= 0 ? "text-green" : "text-red"}`}>
          {cp == null ? "—" : <>{cp >= 0 ? "▲" : "▼"} <LiveNumber value={cp} format="pct" /></>}
        </span>
      </span>
    </Link>
  );
}

export function Heatmap({ groups }: { groups: { title: string; syms: string[] }[] }) {
  useQuotes(groups.flatMap((g) => g.syms));
  return (
    <>
      {groups.map((g) => (
        <section key={g.title} className="mb-5">
          <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-line2">
            <h2 className="heading">{g.title}</h2>
            <span className="text-[10px] text-mut num">{g.syms.length}</span>
          </div>
          <div className="grid gap-2"
               style={{ gridTemplateColumns: "repeat(auto-fit, minmax(136px, 1fr))" }}>
            {g.syms.map((s) => <HeatCell key={s} sym={s} />)}
          </div>
        </section>
      ))}
    </>
  );
}

// ── FX cross-rate matrix ──────────────────────────────────────────────────

const USD_PAIRS = [
  "EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X",
  "USDINR=X", "AUDUSD=X", "USDCAD=X", "USDCNY=X", "USDSGD=X",
];

export function CrossRates() {
  // useLiveTicks rather than a subscription per cell: the whole table is
  // derived from nine pairs, so one rAF-batched refresh beats 81 independent
  // ones. It also re-renders on an actual tick instead of on a timer.
  const ticks = useLiveTicks(USD_PAIRS);
  const m = useMemo(() => crossMatrix(
    USD_PAIRS.map((sym) => ({ sym, rate: ticks.get(sym)?.ltp ?? null })),
    FX_CCYS,
  ), [ticks]);

  return (
    <section className="mb-5">
      <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-line2">
        <h2 className="heading">Cross rates</h2>
        <span className="text-[10px] text-mut">
          one unit of the row currency, priced in the column currency
        </span>
      </div>

      <div className="hud overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr className="border-b border-line2">
              <th className="px-2.5 py-2 text-left label-xs sticky left-0 bg-panel">CCY</th>
              {m.ccys.map((c) => (
                <th key={c} className="px-2.5 py-2 label-xs font-medium text-right">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.ccys.map((base, i) => (
              <tr key={base} className="border-b border-line/60 hover:bg-panel2">
                <td className="px-2.5 py-1.5 text-amber sticky left-0 bg-bg2">{base}</td>
                {m.rows[i].map((v, j) => (
                  <td key={m.ccys[j]}
                      className={`px-2.5 py-1.5 num text-right ${
                        i === j ? "text-mut" : v == null ? "text-mut" : "text-txt"}`}
                      title={v == null ? "One of the two legs isn't quoted by the feed"
                        : `1 ${base} = ${fmtNum(v, fxDigits(v))} ${m.ccys[j]}`}>
                    {v == null ? "—" : fmtNum(v, fxDigits(v))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[10.5px] text-mut mt-2 leading-relaxed">
        Only the dollar pairs are quoted by the feed; every other cell is
        triangulated through USD. That is standard practice, but a derived
        cross is not a quoted one — it carries the staleness of both legs and
        none of the real cross&apos;s bid-ask, so treat it as indicative rather
        than dealable.
        {m.missing.length > 0 && (
          <> {m.missing.join(", ")} {m.missing.length === 1 ? "has" : "have"} no
          usable quote right now, so {m.missing.length === 1 ? "its" : "their"} row
          and column are empty.</>
        )}
      </div>
    </section>
  );
}
