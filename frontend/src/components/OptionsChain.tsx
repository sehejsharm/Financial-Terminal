"use client";

import { useEffect, useMemo, useState } from "react";

import { Methodology } from "@/components/Methodology";
import { Note, SectionHeader } from "@/components/ui";
import { api, type OptionChain, type OptionRow } from "@/lib/api";
import {
  chainNote, daysToExpiry, expectedMove, isItm, ivSkew, oiProfile, tradability,
} from "@/lib/optionsRead";
import { fmtNum } from "@/lib/utils";

// `mobile: false` columns collapse below md — at 375px only
// Strike / Last / IV % / Δ fit legibly.
const COLS: { key: string; label: string; digits?: number; pct?: boolean; mobile?: boolean }[] = [
  { key: "strike", label: "Strike", digits: 1, mobile: true },
  { key: "lastPrice", label: "Last", digits: 2, mobile: true },
  { key: "bid", label: "Bid", digits: 2 },
  { key: "ask", label: "Ask", digits: 2 },
  { key: "volume", label: "Vol", digits: 0 },
  { key: "openInterest", label: "OI", digits: 0 },
  // IV arrives as a decimal (0.35) — display as 35.0%.
  { key: "impliedVolatility", label: "IV %", digits: 1, pct: true, mobile: true },
  { key: "delta", label: "Δ", digits: 3, mobile: true },
  { key: "gamma", label: "Γ", digits: 4 },
  { key: "theta", label: "Θ", digits: 3 },
  { key: "vega", label: "ν", digits: 3 },
];

const respCls = (c: { mobile?: boolean }) => (c.mobile ? "" : "hidden md:table-cell");

function OptTable({ rows, spot, side, wall }: {
  rows: OptionRow[]; spot: number; side: "calls" | "puts"; wall: number | null;
}) {
  if (!rows.length) return <div className="panel-2 p-3 text-mut text-xs">No contracts.</div>;
  return (
    <div className="panel overflow-auto max-h-[460px]">
      <table className="w-full text-[11px]">
        <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
          <tr className="border-b border-line">
            {COLS.map((c) => (
              <th key={c.key} className={`text-right px-2 py-1.5 font-medium ${respCls(c)}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const strike = typeof r.strike === "number" ? r.strike : null;
            // A put is in the money ABOVE the spot. The old rule shaded both
            // sides as if they were calls, so every put row was backwards.
            const itm = isItm(strike, spot, side);
            const isWall = wall != null && strike === wall;
            return (
              <tr key={i}
                  className={`border-b border-line/50 hover:bg-panel ${itm ? "bg-amber/5" : ""}`}
                  title={isWall ? "Heaviest open interest on this side of the spot" : undefined}>
                {COLS.map((c) => {
                  const v = r[c.key];
                  return (
                    <td key={c.key}
                        className={`px-2 py-1 num text-right ${respCls(c)} ${
                          isWall && c.key === "openInterest"
                            ? "text-amber font-semibold" : "text-txt/90"}`}>
                      {typeof v === "number" ? fmtNum(c.pct ? v * 100 : v, c.digits ?? 2) : "—"}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * OMON — the option chain, and what it is saying.
 *
 * The grid was a data dump: eleven columns of Greeks and a max-pain figure,
 * with every question a chain is consulted for left unanswered. How far does
 * the market think this moves by expiry? Is protection dearer than
 * participation? Where is the open interest piled up? Can any of this be
 * traded at the prices shown? All four come off the rows already fetched, so
 * they are computed here and stated in words above the grid.
 */
export function OptionsChain({ ticker }: { ticker: string }) {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>("");
  const [data, setData] = useState<OptionChain | null>(null);
  const [side, setSide] = useState<"calls" | "puts">("calls");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [expiriesLoaded, setExpiriesLoaded] = useState(false);

  useEffect(() => {
    setErr(null); setData(null); setExpiries([]); setExpiry(""); setExpiriesLoaded(false);
    api.optionExpiries(ticker)
      .then((ex) => { setExpiries(ex); if (ex.length) setExpiry(ex[0]); })
      .catch((e) => setErr(e?.detail || "No options for this symbol."))
      .finally(() => setExpiriesLoaded(true));
  }, [ticker]);

  useEffect(() => {
    if (!expiry) return;
    setBusy(true); setErr(null);
    api.optionChain(ticker, expiry)
      .then(setData)
      .catch((e) => setErr(e?.detail || "Failed to load chain."))
      .finally(() => setBusy(false));
  }, [ticker, expiry]);

  const spot = data?.spot ?? 0;
  const move = useMemo(
    () => (data ? expectedMove(data.calls, data.puts, spot) : null), [data, spot]);
  const skew = useMemo(
    () => (data ? ivSkew(data.calls, data.puts, spot) : null), [data, spot]);
  const oi = useMemo(
    () => (data ? oiProfile(data.calls, data.puts, spot) : null), [data, spot]);
  const trade = useMemo(
    () => (data ? tradability([...data.calls, ...data.puts]) : null), [data]);
  // Read once per render rather than per row: a clock read inside the table
  // would make every row's day count a fraction different.
  const dte = useMemo(
    () => (expiry ? daysToExpiry(expiry, Date.now()) : null), [expiry]);

  if (err && !expiries.length) return <div className="panel-2 p-4 text-mut text-sm">{err}</div>;

  const isIndian = /\.(NS|BO)$/i.test(ticker);
  if (expiriesLoaded && !err && expiries.length === 0) {
    return (
      <div className="panel-2 p-4 text-mut text-sm">
        No option expiries available for <span className="text-amber">{ticker}</span>.
        {isIndian
          ? " NSE F&O chains aren't wired into the free data layer yet — options work for US-listed tickers (e.g. AAPL, SPY)."
          : " The data provider returned no listed expiries for this symbol — it may not have exchange-traded options."}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="input-bare cursor-pointer">
          {expiries.map((e) => <option key={e}>{e}</option>)}
        </select>
        {dte != null && (
          <span className="text-[11px] text-mut whitespace-nowrap">
            {dte <= 0 ? "expired" : `${dte}d to expiry`}
          </span>
        )}
        <div className="flex gap-2">
          <button onClick={() => setSide("calls")} className={`btn ${side === "calls" ? "btn-primary" : "btn-ghost"}`}>Calls</button>
          <button onClick={() => setSide("puts")} className={`btn ${side === "puts" ? "btn-primary" : "btn-ghost"}`}>Puts</button>
        </div>
        <div className="flex-1" />
        {data && (
          <div className="flex gap-3 text-[11px] text-mut">
            <span>Spot <span className="num text-txt">{fmtNum(data.spot, 2)}</span></span>
            {data.max_pain != null && <span>Max pain <span className="num text-amber">{fmtNum(data.max_pain, 1)}</span></span>}
          </div>
        )}
      </div>

      {busy && <div className="text-mut text-xs">Loading chain & Greeks…</div>}
      {err && expiries.length > 0 && <div className="text-red text-sm mb-2">{err}</div>}

      {data && !busy && move && skew && oi && trade && (
        <>
          <SectionHeader title="What the chain is pricing" />
          <div className="grid gap-2.5 mb-2.5"
               style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
            <div className="hud p-3"
                 title="The at-the-money straddle: what the market charges to own a move in either direction">
              <div className="label-xs">Expected move by expiry</div>
              <div className={`num text-lg mt-0.5 ${move.pct == null ? "text-mut" : "text-amber"}`}>
                {move.pct == null ? "—" : `±${fmtNum(move.pct, 1)}%`}
              </div>
              {move.lower != null && move.upper != null && (
                <div className="text-[10px] text-mut mt-1 num">
                  {fmtNum(move.lower, 1)} – {fmtNum(move.upper, 1)}
                </div>
              )}
            </div>
            <div className="hud p-3" title="10% out-of-the-money put IV minus the equivalent call IV">
              <div className="label-xs">Put skew (10% OTM)</div>
              <div className={`num text-lg mt-0.5 ${
                skew.points == null ? "text-mut"
                  : skew.points > 2 ? "text-red"
                  : skew.points < -2 ? "text-green" : "text-txt"}`}>
                {skew.points == null
                  ? "—" : `${skew.points >= 0 ? "+" : ""}${fmtNum(skew.points, 1)} pts`}
              </div>
              {skew.atmIv != null && (
                <div className="text-[10px] text-mut mt-1 num">
                  ATM IV {fmtNum(skew.atmIv, 1)}%
                </div>
              )}
            </div>
            <div className="hud p-3">
              <div className="label-xs">Put / call open interest</div>
              <div className="num text-lg mt-0.5 text-txt">
                {oi.putCallRatio == null ? "—" : `${fmtNum(oi.putCallRatio, 2)}x`}
              </div>
              <div className="text-[10px] text-mut mt-1 num">
                {oi.putWall != null && `put wall ${fmtNum(oi.putWall, 1)}`}
                {oi.putWall != null && oi.callWall != null && " · "}
                {oi.callWall != null && `call wall ${fmtNum(oi.callWall, 1)}`}
              </div>
            </div>
            <div className="hud p-3" title="Median bid-ask spread as a share of the mid price">
              <div className="label-xs">Median spread</div>
              <div className={`num text-lg mt-0.5 ${
                trade.verdict === "tradable" ? "text-green"
                  : trade.verdict === "illiquid" ? "text-red"
                  : trade.verdict === "wide" ? "text-amber" : "text-mut"}`}>
                {trade.medianSpreadPct == null
                  ? "—" : `${fmtNum(trade.medianSpreadPct, 1)}%`}
              </div>
              <div className="text-[10px] text-mut mt-1 capitalize">{trade.verdict}</div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5 mb-4">
            {move.problem && <Note>{move.problem}</Note>}
            {!move.problem && move.pct != null && (
              <Note>
                The at-the-money straddle at {fmtNum(move.strike!, 1)} costs{" "}
                {fmtNum(move.amount!, 2)}, so the market is pricing a move of
                roughly ±{fmtNum(move.pct, 1)}% by expiry. That is a one-standard-
                deviation-ish range, not a bound: it is wrong about a third of
                the time by construction.
              </Note>
            )}
            <Note>{skew.read}</Note>
            <Note>{oi.read}</Note>
            <Note>{trade.read}</Note>
          </div>

          <SectionHeader title={side === "calls" ? "Calls" : "Puts"}
                         count={`${side === "calls" ? data.calls.length : data.puts.length} contracts`} />
          <OptTable rows={side === "calls" ? data.calls : data.puts}
                    spot={data.spot} side={side}
                    wall={side === "calls" ? oi.callWall : oi.putWall} />
          <div className="mt-2">
            <Note>{chainNote(dte, trade)}</Note>
          </div>
          <Methodology id="optionChain" className="mt-3" />
        </>
      )}
    </div>
  );
}
