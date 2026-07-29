"use client";

import { useEffect, useRef, useState } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Methodology } from "@/components/Methodology";
import { api, type Snapshot } from "@/lib/api";
import { curSymbol, humanNumber } from "@/lib/utils";

/** Numeric field with its own text state. Defined at module level on
 *  purpose: when this lived inside Wacc() it was a brand-new component type
 *  on every render, so React remounted the <input> per keystroke — fast
 *  typing lost focus mid-word and "10" became "1". The raw text updates
 *  instantly; the parsed number flows up and recalculates the model. */
function NumField({ label, value, set, step = 1, readout }: {
  label: string; value: number; set: (n: number) => void; step?: number; readout?: string | null;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  // Adopt external updates (snapshot load fills defaults) unless the user is
  // mid-edit in this exact field.
  useEffect(() => {
    if (!focused.current && parseFloat(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="label-xs">{label}</span>
      <input
        type="number" value={text} step={step}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setText(String(value)); }}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) set(n);
        }}
        className="input-bare"
      />
      {readout && <span className="text-[10.5px] text-mut num">= {readout}</span>}
    </label>
  );
}

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

  // <input type="number"> can't render thousands separators, so large inputs
  // (equity/debt) get a humanised readout under the field instead of leaving
  // the user to count digits in a raw integer.
  const big = (n: number) => (Math.abs(n) >= 1e6 ? humanNumber(n, cur) : null);

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <NumField label={`Equity value (mkt cap, ${cur})`} value={equity} set={setEquity} step={1e9} readout={big(equity)} />
        <NumField label={`Total debt (${cur})`} value={debt} set={setDebt} step={1e9} readout={big(debt)} />
        <NumField label="Beta" value={beta} set={setBeta} step={0.05} />
        <NumField label="Risk-free rate %" value={rf} set={setRf} step={0.25} />
        <NumField label="Equity risk premium %" value={erp} set={setErp} step={0.25} />
        <NumField label="Pre-tax cost of debt %" value={costDebt} set={setCostDebt} step={0.25} />
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
      <Methodology id="wacc" className="mt-3" />
    </div>
  );
}
