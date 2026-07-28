"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, Plus, Trash2 } from "lucide-react";

import { ScrollX } from "@/components/ScrollX";
import {
  analyse, payoffCurve, PRESETS, probProfit, roundToStep, strategyGreeks,
  strikeStep, type Leg, type PresetId, type PriceInputs,
} from "@/lib/optionStrategy";
import { realizedVol, logReturns } from "@/lib/vol";
import { api } from "@/lib/api";
import { fmtNum } from "@/lib/utils";

/**
 * OVME — vanilla option strategy builder.
 *
 * A THEORETICAL pricer, and it says so up front: there is no live option
 * chain on the free data path, so every premium here comes from the vol the
 * user supplies, not from a quoted market. What it does give you is the thing
 * a structure builder is actually for — payoff shape, breakevens, bounded vs
 * unbounded risk, and net greeks — computed instantly as you drag strikes.
 *
 * The vol input is seeded from the name's own 30-day realized vol so the
 * starting point is grounded in something real rather than a round number.
 */

let seq = 0;
const newId = () => `leg${++seq}`;

const EXPIRIES = [
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "1 year", days: 365 },
];

function pick(c: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (c[k] != null) return c[k];
  return null;
}

function PayoffChart({ curve, spot, breakevens }: {
  curve: { spot: number; expiry: number; now: number }[];
  spot: number; breakevens: number[];
}) {
  const W = 720, H = 240, L = 52, R = 10, T = 10, B = 26;
  const vals = curve.flatMap((p) => [p.expiry, p.now]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const sx = (s: number) =>
    L + ((s - curve[0].spot) / (curve[curve.length - 1].spot - curve[0].spot)) * (W - L - R);
  const sy = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const path = (f: (p: (typeof curve)[number]) => number) =>
    curve.map((p, i) => `${i ? "L" : "M"}${sx(p.spot).toFixed(1)},${sy(f(p)).toFixed(1)}`).join("");

  // Profit/loss shading against the zero line.
  const zero = sy(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[240px]">
      <defs>
        <clipPath id="ovme-up"><rect x={L} y={T} width={W - L - R} height={Math.max(0, zero - T)} /></clipPath>
        <clipPath id="ovme-dn"><rect x={L} y={zero} width={W - L - R} height={Math.max(0, H - B - zero)} /></clipPath>
      </defs>

      {[y0, (y0 + y1) / 2, y1].map((v, i) => (
        <g key={i}>
          <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="var(--c-line)" strokeWidth={0.5} />
          <text x={L - 6} y={sy(v) + 3} textAnchor="end" fontSize="9" fill="var(--c-mut)">
            {fmtNum(v, 0)}
          </text>
        </g>
      ))}

      <path d={`${path((p) => p.expiry)}L${sx(curve[curve.length - 1].spot)},${zero}L${sx(curve[0].spot)},${zero}Z`}
            fill="var(--c-green)" opacity={0.14} clipPath="url(#ovme-up)" />
      <path d={`${path((p) => p.expiry)}L${sx(curve[curve.length - 1].spot)},${zero}L${sx(curve[0].spot)},${zero}Z`}
            fill="var(--c-red)" opacity={0.14} clipPath="url(#ovme-dn)" />

      <line x1={L} x2={W - R} y1={zero} y2={zero} stroke="var(--c-mut)" strokeWidth={0.8} />
      <line x1={sx(spot)} x2={sx(spot)} y1={T} y2={H - B} stroke="var(--c-amber)"
            strokeWidth={0.8} strokeDasharray="3 3" />
      <text x={sx(spot)} y={H - 14} textAnchor="middle" fontSize="8.5" fill="var(--c-amber)">spot</text>

      {breakevens.map((b) => (
        <g key={b}>
          <line x1={sx(b)} x2={sx(b)} y1={T} y2={H - B} stroke="var(--c-mut)" strokeWidth={0.6} strokeDasharray="2 4" />
          <text x={sx(b)} y={T + 9} textAnchor="middle" fontSize="8.5" fill="var(--c-mut)">
            {fmtNum(b, 1)}
          </text>
        </g>
      ))}

      <path d={path((p) => p.now)} fill="none" stroke="var(--c-mut)" strokeWidth={1.2} strokeDasharray="4 3" />
      <path d={path((p) => p.expiry)} fill="none" stroke="var(--c-amber)" strokeWidth={1.8} />

      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const s = curve[0].spot + f * (curve[curve.length - 1].spot - curve[0].spot);
        return (
          <text key={f} x={sx(s)} y={H - 3} textAnchor="middle" fontSize="9" fill="var(--c-mut)">
            {fmtNum(s, 0)}
          </text>
        );
      })}
    </svg>
  );
}

export function OptionBuilder({ ticker, spot: spotProp }: {
  ticker: string; spot?: number | null;
}) {
  const [spot, setSpot] = useState<number>(spotProp && spotProp > 0 ? spotProp : 100);
  const [vol, setVol] = useState(25);            // vol POINTS
  const [rate, setRate] = useState(6);           // percent
  const [days, setDays] = useState(30);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [volSource, setVolSource] = useState<string | null>(null);

  const step = strikeStep(spot);
  const R = useMemo(() => (x: number) => roundToStep(x, step), [step]);

  // Seed vol from the name's own 30-day realized vol — a grounded starting
  // point beats a round number, and it's labelled so it isn't mistaken for a
  // market quote.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const h = await api.history(ticker, "1Y");
        const closes: number[] = [];
        for (const c of h.candles ?? []) {
          const cl = pick(c as Record<string, unknown>, ["close", "Close"]);
          if (typeof cl === "number") closes.push(cl);
        }
        if (dead || closes.length < 40) return;
        const rv = realizedVol(logReturns(closes), 30);
        if (Number.isFinite(rv)) {
          setVol(Math.round(rv * 10) / 10);
          setVolSource("seeded from 30-day realized vol");
        }
        if (!(spotProp && spotProp > 0) && closes.length) setSpot(closes[closes.length - 1]);
      } catch { /* keep the defaults */ }
    })();
    return () => { dead = true; };
  }, [ticker, spotProp]);

  useEffect(() => {
    if (spotProp && spotProp > 0) setSpot(spotProp);
  }, [spotProp]);

  // Start with something on screen rather than an empty canvas.
  const [preset, setPreset] = useState<PresetId>("bull_call_spread");
  // Strikes are laid out once per (preset, spot-at-layout-time). Spot is a
  // LIVE price here — rebuilding whenever it moves would silently discard the
  // user's hand-edited legs mid-session, so the layout spot is latched and
  // only re-latched when the price has drifted far enough that the old
  // strikes are no longer in the right neighbourhood.
  const laidOutAt = useRef<number | null>(null);
  useEffect(() => {
    if (!(spot > 0)) return;
    const anchor = laidOutAt.current;
    if (anchor != null && Math.abs(spot / anchor - 1) < 0.1) return;
    laidOutAt.current = spot;
    const p = PRESETS.find((x) => x.id === preset)!;
    setLegs(p.build(spot, R).map((l) => ({ ...l, id: newId() })));
  }, [preset, spot, R]);

  // A new structure always relays out, at whatever spot is current.
  useEffect(() => { laidOutAt.current = null; }, [preset, ticker]);

  const inputs: PriceInputs = useMemo(
    () => ({ S: spot, T: days / 365, r: rate / 100, sigma: vol / 100, q: 0 }),
    [spot, days, rate, vol]);

  const g = useMemo(() => strategyGreeks(legs, inputs), [legs, inputs]);
  const prof = useMemo(() => analyse(legs, inputs), [legs, inputs]);
  const pop = useMemo(() => probProfit(legs, inputs), [legs, inputs]);
  const curve = useMemo(
    () => (legs.length ? payoffCurve(legs, inputs, spot * 0.7, spot * 1.3, 121) : []),
    [legs, inputs, spot]);

  const presetDef = PRESETS.find((x) => x.id === preset)!;

  function setLeg(id: string, patch: Partial<Leg>) {
    setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Layers size={14} className="text-amber" />
        <h2 className="heading">OVME — OPTION STRATEGY BUILDER</h2>
      </div>

      <div className="panel-2 p-3 mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 min-w-[160px]">
          <span className="label-xs">Structure</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value as PresetId)}
                  className="input-bare !py-1 text-xs">
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 w-[100px]">
          <span className="label-xs">Spot</span>
          <input type="number" value={spot} step={step}
                 onChange={(e) => setSpot(Math.max(0.01, parseFloat(e.target.value) || 0.01))}
                 className="input-bare !py-1 text-xs num w-full" />
        </label>
        <label className="flex flex-col gap-1 w-[90px]"
               title={volSource ?? "Annualised volatility used to price every leg"}>
          <span className="label-xs">Vol %</span>
          <input type="number" value={vol} min={1} max={300} step={0.5}
                 onChange={(e) => setVol(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
                 className="input-bare !py-1 text-xs num w-full" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-xs">Expiry</span>
          <select value={days} onChange={(e) => setDays(parseInt(e.target.value, 10))}
                  className="input-bare !py-1 text-xs">
            {EXPIRIES.map((x) => <option key={x.days} value={x.days}>{x.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 w-[80px]">
          <span className="label-xs">Rate %</span>
          <input type="number" value={rate} min={0} max={30} step={0.25}
                 onChange={(e) => setRate(Math.max(0, parseFloat(e.target.value) || 0))}
                 className="input-bare !py-1 text-xs num w-full" />
        </label>
      </div>

      <div className="text-[11px] text-mut mb-3">
        {presetDef.intent}
        {presetDef.stockNote && <> <span className="text-amber">{presetDef.stockNote}</span></>}
      </div>

      {/* ── legs ── */}
      <div className="panel mb-3">
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <span className="heading">Legs</span>
          <div className="flex-1" />
          <button onClick={() => setLegs((ls) => [...ls,
                    { id: newId(), kind: "call", dir: 1, strike: R(spot), qty: 1 }])}
                  className="btn-ghost text-xs flex items-center gap-1">
            <Plus size={11} /> Add leg
          </button>
        </div>
        <ScrollX>
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line">
                <th className="text-left px-3 py-2 font-medium">Side</th>
                <th className="text-left px-3 py-2 font-medium">Type</th>
                <th className="text-right px-3 py-2 font-medium">Strike</th>
                <th className="text-right px-3 py-2 font-medium">Qty</th>
                <th className="text-right px-3 py-2 font-medium">Premium</th>
                <th className="text-right px-3 py-2 font-medium">Δ</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {legs.map((l) => {
                const lg = strategyGreeks([l], inputs);
                return (
                  <tr key={l.id} className="border-b border-line/60">
                    <td className="px-3 py-1.5">
                      <select value={l.dir} onChange={(e) => setLeg(l.id, { dir: parseInt(e.target.value, 10) as 1 | -1 })}
                              className={`input-bare !py-0.5 text-xs ${l.dir === 1 ? "text-green" : "text-red"}`}>
                        <option value={1}>Buy</option>
                        <option value={-1}>Sell</option>
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <select value={l.kind} onChange={(e) => setLeg(l.id, { kind: e.target.value as "call" | "put" })}
                              className="input-bare !py-0.5 text-xs">
                        <option value="call">Call</option>
                        <option value="put">Put</option>
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <input type="number" value={l.strike} step={step} min={step}
                             onChange={(e) => setLeg(l.id, { strike: Math.max(step, parseFloat(e.target.value) || step) })}
                             className="input-bare !py-0.5 text-xs num w-24 text-right" />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <input type="number" value={l.qty} min={1} max={100} step={1}
                             onChange={(e) => setLeg(l.id, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                             className="input-bare !py-0.5 text-xs num w-14 text-right" />
                    </td>
                    <td className={`px-3 py-1.5 num text-right ${lg.price < 0 ? "text-green" : ""}`}>
                      {fmtNum(Math.abs(lg.price), 2)} {lg.price < 0 ? "cr" : "dr"}
                    </td>
                    <td className="px-3 py-1.5 num text-right text-mut">{fmtNum(lg.delta, 3)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => setLegs((ls) => ls.filter((x) => x.id !== l.id))}
                              className="text-mut hover:text-red" title="Remove leg">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {legs.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-4 text-center text-mut">
                  No legs — pick a structure above or add one.
                </td></tr>
              )}
            </tbody>
          </table>
        </ScrollX>
      </div>

      {legs.length > 0 && (
        <>
          {/* ── summary ── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3">
            <div className="panel-2 px-3 py-2">
              <div className="label-xs">{g.netDebit >= 0 ? "Net debit" : "Net credit"}</div>
              <div className={`num text-sm mt-0.5 ${g.netDebit >= 0 ? "text-red" : "text-green"}`}>
                {fmtNum(Math.abs(g.netDebit), 2)}
              </div>
            </div>
            <div className="panel-2 px-3 py-2" title="Best case at expiry; unbounded means there is no cap">
              <div className="label-xs">Max profit</div>
              <div className="num text-sm mt-0.5 text-green">
                {prof.maxProfit == null ? "unbounded" : fmtNum(prof.maxProfit, 2)}
              </div>
            </div>
            <div className="panel-2 px-3 py-2"
                 title="Worst case at expiry. 'Unbounded' is not a large number — it is no floor at all.">
              <div className="label-xs">Max loss</div>
              <div className="num text-sm mt-0.5 text-red">
                {prof.maxLoss == null ? "unbounded" : fmtNum(Math.abs(prof.maxLoss), 2)}
              </div>
            </div>
            <div className="panel-2 px-3 py-2">
              <div className="label-xs">Breakeven{prof.breakevens.length === 1 ? "" : "s"}</div>
              <div className="num text-sm mt-0.5">
                {prof.breakevens.length ? prof.breakevens.map((b) => fmtNum(b, 1)).join(" / ") : "—"}
              </div>
            </div>
            <div className="panel-2 px-3 py-2"
                 title="Under the same lognormal assumption used to price the legs — real tails are fatter">
              <div className="label-xs">Model P(profit)</div>
              <div className="num text-sm mt-0.5">{pop == null ? "—" : `${fmtNum(pop * 100, 0)}%`}</div>
            </div>
            <div className="panel-2 px-3 py-2" title="Move in the structure's value per 1 point of spot">
              <div className="label-xs">Net delta</div>
              <div className="num text-sm mt-0.5">{fmtNum(g.delta, 3)}</div>
            </div>
          </div>

          <div className="panel p-3 mb-3">
            <PayoffChart curve={curve} spot={spot} breakevens={prof.breakevens} />
            <div className="flex flex-wrap items-center gap-4 text-[10.5px] text-mut mt-1">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 h-[2px]" style={{ background: "var(--c-amber)" }} /> At expiry
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 border-t border-dashed" style={{ borderColor: "var(--c-mut)" }} /> Today ({days}d to go)
              </span>
              <span>P&amp;L per 1 unit of the underlying, net of premium.</span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
            {([["Delta", g.delta, 3, "per 1 point of spot"],
               ["Gamma", g.gamma, 4, "delta change per 1 point of spot"],
               ["Theta", g.theta, 3, "per calendar day"],
               ["Vega", g.vega, 3, "per 1 vol point"],
               ["Rho", g.rho, 3, "per 1% rate move"]] as const).map(([label, v, d, note]) => (
              <div key={label} className="panel-2 px-3 py-2" title={note}>
                <div className="label-xs">{label}</div>
                <div className={`num text-sm mt-0.5 ${v < 0 ? "text-red" : v > 0 ? "text-green" : ""}`}>
                  {fmtNum(v, d)}
                </div>
                <div className="text-[9.5px] text-mut">{note}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="text-[10.5px] text-mut leading-relaxed">
        <span className="text-amber">Theoretical pricing, not market quotes.</span> There is
        no live option chain on this data path, so every premium above is
        Black-Scholes at the {vol}% volatility in the box{volSource ? ` (${volSource})` : ""} —
        not what anyone would actually charge you. Real quotes carry a bid-ask
        spread, a volatility skew across strikes that a single vol number cannot
        express, and for Indian names a lot size that makes the true ticket a
        multiple of the per-unit figures here.
        {" "}Greeks assume European exercise, no dividends and a constant rate.
        &ldquo;Model P(profit)&rdquo; is the lognormal probability implied by the same
        assumptions used to price the legs — real return distributions have fatter
        tails, so tail-risk structures are riskier than it suggests. Educational
        analysis only, not advice.
      </div>
    </div>
  );
}
