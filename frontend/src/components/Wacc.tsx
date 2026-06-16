"use client";

import { useEffect, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { api, type Snapshot } from "@/lib/api";
import { curSymbol, humanNumber } from "@/lib/utils";

/**
 * Weighted Average Cost of Capital. Pure client-side maths (CAPM + WACC) —
 * defaults pre-filled from the snapshot (market cap, beta) and capital structure.
 */
export function Wacc({ ticker, snap }: { ticker: string; snap: Snapshot | null }) {
  const [equity, setEquity] = useState(0);
  const [debt, setDebt] = useState(0);
  const [beta, setBeta] = useState(1);
  const [rf, setRf] = useState(7);
  const [erp, setErp] = useState(6);
  const [costDebt, setCostDebt] = useState(8);
  const [tax, setTax] = useState(25);

  useEffect(() => {
    setEquity(Number(snap?.market_cap ?? 0));
    setBeta(Number(snap?.beta ?? 1) || 1);
    api.capitalStructure(ticker).then((c) => setDebt(Number(c.total_debt ?? 0))).catch(() => setDebt(0));
  }, [ticker, snap]);

  const re = rf + (beta || 1) * erp;                 // CAPM
  const v = equity + debt;
  const we = v > 0 ? equity / v : null;
  const wd = v > 0 ? debt / v : null;
  const wacc = we != null && wd != null ? we * re + wd * costDebt * (1 - tax / 100) : null;
  const cur = curSymbol((snap?.currency as string) || "USD");

  const Num = ({ label, value, set, step = 1 }: { label: string; value: number; set: (n: number) => void; step?: number }) => (
    <label className="flex flex-col gap-1">
      <span className="label-xs">{label}</span>
      <input type="number" value={value} step={step} onChange={(e) => set(parseFloat(e.target.value) || 0)} className="input-bare" />
    </label>
  );

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <Num label={`Equity value (mkt cap, ${cur})`} value={equity} set={setEquity} step={1e9} />
        <Num label={`Total debt (${cur})`} value={debt} set={setDebt} step={1e9} />
        <Num label="Beta" value={beta} set={setBeta} step={0.05} />
        <Num label="Risk-free rate %" value={rf} set={setRf} step={0.25} />
        <Num label="Equity risk premium %" value={erp} set={setErp} step={0.25} />
        <Num label="Pre-tax cost of debt %" value={costDebt} set={setCostDebt} step={0.25} />
      </div>
      <label className="flex flex-col gap-1 mb-5 max-w-sm">
        <span className="label-xs">Tax rate % — {tax}</span>
        <input type="range" min={0} max={50} value={tax} onChange={(e) => setTax(parseInt(e.target.value))} className="accent-amber" />
      </label>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <MetricCard label="Cost of equity (CAPM)" value={`${re.toFixed(2)}%`} />
        <MetricCard label="Capital weights (E / D)"
                    value={we != null ? `${(we * 100).toFixed(0)}% / ${(wd! * 100).toFixed(0)}%` : "—"} />
        <MetricCard label="WACC" value={wacc != null ? `${wacc.toFixed(2)}%` : "—"} tone="positive" />
      </div>
      <div className="text-[10.5px] text-mut mt-3">
        Enterprise value ≈ {humanNumber(v, cur)}. Adjust any input to re-model.
      </div>
    </div>
  );
}
