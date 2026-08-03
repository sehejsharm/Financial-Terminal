"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { MetricCard } from "@/components/MetricCard";
import { Methodology } from "@/components/Methodology";
import { Note, SectionHeader } from "@/components/ui";
import { api, type Snapshot } from "@/lib/api";
import { tintBg } from "@/lib/heat";
import {
  AXES, axisValue, filedTaxRate, impliedMultiple, REGIONS, regionFor,
  resolveTaxRate, sensitivity, valueSpread, waccFlags, waccModel, waccNote,
  type Axis, type TaxRate, type WaccInputs,
} from "@/lib/waccModel";
import { curSymbol, fmtNum, humanNumber } from "@/lib/utils";

/** Numeric field with its own text state. Defined at module level on
 *  purpose: when this lived inside Wacc() it was a brand-new component type
 *  on every render, so React remounted the <input> per keystroke — fast
 *  typing lost focus mid-word and "10" became "1". The raw text updates
 *  instantly; the parsed number flows up and recalculates the model. */
function NumField({ label, value, set, step = 1, readout, hint }: {
  label: string; value: number; set: (n: number) => void; step?: number;
  readout?: string | null; hint?: string;
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
    <label className="flex flex-col gap-1" title={hint}>
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
 * Weighted Average Cost of Capital — and, more usefully, what it implies.
 *
 * The old screen computed one number from seven inputs and stopped. This one
 * also shows how little that number is worth (a two-axis sensitivity grid, on
 * the two assumptions nobody can observe), what it implies for a terminal
 * multiple, and whether the business actually earns more than its capital
 * costs. That last comparison is the point of the exercise and was missing.
 */
export function Wacc({ ticker, snap }: { ticker: string; snap: Snapshot | null }) {
  const region = useMemo(
    () => regionFor(ticker, snap?.currency as string | undefined), [ticker, snap]);
  const [regionKey, setRegionKey] = useState(region.key);
  const active = REGIONS.find((r) => r.key === regionKey) ?? region;

  const [equity, setEquity] = useState(0);
  const [debt, setDebt] = useState(0);
  const [beta, setBeta] = useState(1);
  const [rf, setRf] = useState(region.rf);
  const [erp, setErp] = useState(region.erp);
  const [costDebt, setCostDebt] = useState(region.rd);
  const [tax, setTax] = useState(region.tax);
  const [premium, setPremium] = useState(0);
  const [growth, setGrowth] = useState(3);
  // Where the tax rate came from. Once the user moves the slider it is
  // theirs, and no later fetch may quietly overwrite it.
  const [taxRate, setTaxRate] = useState<TaxRate | null>(null);
  const [taxTouched, setTaxTouched] = useState(false);

  const [rowAxis, setRowAxis] = useState<Axis>("beta");
  const [colAxis, setColAxis] = useState<Axis>("erp");

  // Region change (whether from the ticker or the picker) resets the rate
  // assumptions. Equity, debt and beta are facts about the company and are
  // deliberately left alone.
  useEffect(() => {
    setRegionKey(region.key);
    setRf(region.rf); setErp(region.erp); setCostDebt(region.rd);
    // The tax rate is the company's, not the region's — it is resolved from
    // the filings below. Only seed it here so there is something sane before
    // the statements land, and never over a rate the user has chosen.
    setTaxTouched(false);
    setTax(region.tax);
    setTaxRate(null);
  }, [region]);

  function pickRegion(key: string) {
    const r = REGIONS.find((x) => x.key === key);
    if (!r) return;
    setRegionKey(key);
    setRf(r.rf); setErp(r.erp); setCostDebt(r.rd);
    // Picking a region changes the STATUTORY rate. A rate read from this
    // company's own filings is a fact about the company, so it survives.
    if (!taxRate || taxRate.source === "statutory") {
      setTax(r.tax);
      setTaxRate(null);
    }
  }

  useEffect(() => {
    setEquity(Number(snap?.market_cap ?? 0));
    setBeta(Number(snap?.beta ?? 1) || 1);
    api.capitalStructure(ticker)
      .then((c) => setDebt(Number(c.total_debt ?? 0)))
      .catch(() => setDebt(0));
  }, [ticker, snap]);

  // The tax rate the company ACTUALLY pays, from its own filings. The
  // statutory rate is what the government charges; most companies pay less,
  // and discounting with statutory overstates the interest shield.
  useEffect(() => {
    let alive = true;
    api.statement(ticker, "income", false)
      .then((meta) => {
        if (!alive) return;
        const st = meta?.data;
        const rowFor = (names: string[]) => {
          const r = (st?.rows ?? []).find((x) =>
            names.some((n) => String(x.line).toLowerCase().includes(n)));
          return r ? (st!.columns ?? []).map((c) =>
            typeof r[c] === "number" ? (r[c] as number) : null) : [];
        };
        const filed = filedTaxRate(
          rowFor(["tax provision", "tax expense", "income tax", "tax"]),
          rowFor(["pre-tax", "pretax", "profit before tax", "ebt"]));
        const resolved = resolveTaxRate(filed, region.tax, region.label);
        setTaxRate(resolved);
        // Never over a rate the user has set: the whole point is that it is
        // a starting value they can override, not a value that fights back.
        if (!taxTouched) setTax(resolved.pct);
      })
      .catch(() => { if (alive) setTaxRate(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, region]);

  const inputs: WaccInputs = useMemo(
    () => ({ equity, debt, beta, rf, erp, rd: costDebt, tax, premium }),
    [equity, debt, beta, rf, erp, costDebt, tax, premium]);

  const r = useMemo(() => waccModel(inputs), [inputs]);
  const grid = useMemo(
    () => (r.wacc != null ? sensitivity(inputs, rowAxis, colAxis) : null),
    [inputs, rowAxis, colAxis, r.wacc]);
  const flags = useMemo(() => waccFlags(inputs, r), [inputs, r]);
  const implied = useMemo(() => impliedMultiple(r.wacc, growth), [r.wacc, growth]);
  // The snapshot carries ROCE as a fraction, and ROCE is the right comparison:
  // it is a return on ALL capital, which is what the WACC is the cost of. ROE
  // is a return to one side of the structure only.
  const roce = (snap?.roce as number | undefined) ?? null;
  const spread = useMemo(() => valueSpread(r.wacc, roce), [r.wacc, roce]);

  const cur = curSymbol((snap?.currency as string) || "USD");
  // <input type="number"> can't render thousands separators, so large inputs
  // (equity/debt) get a humanised readout under the field instead of leaving
  // the user to count digits in a raw integer.
  const big = (n: number) => (Math.abs(n) >= 1e6 ? humanNumber(n, cur) : null);

  const centre = grid ? grid.wacc[grid.centreRow][grid.centreCol] : null;
  const axisLabel = (a: Axis) => AXES.find((x) => x.key === a)!.label;
  const axisUnit = (a: Axis) => AXES.find((x) => x.key === a)!.unit;
  const tickLabel = (a: Axis, v: number) =>
    `${fmtNum(v, a === "beta" ? 2 : 1)}${axisUnit(a)}`;

  return (
    <div>
      <SectionHeader
        title="Assumptions"
        actions={
          <label className="flex items-center gap-2 text-[11px]">
            <span className="text-mut">Rate set</span>
            <select value={regionKey} onChange={(e) => pickRegion(e.target.value)}
                    className="input-bare py-0.5 text-[11px]">
              {REGIONS.map((x) => (
                <option key={x.key} value={x.key}>{x.label}</option>
              ))}
            </select>
          </label>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <NumField label={`Equity value (mkt cap, ${cur})`} value={equity}
                  set={setEquity} step={1e9} readout={big(equity)} />
        <NumField label={`Total debt (${cur})`} value={debt} set={setDebt}
                  step={1e9} readout={big(debt)}
                  hint="Book value from the latest balance sheet, not market value" />
        <NumField label="Beta" value={beta} set={setBeta} step={0.05}
                  hint="The provider's levered beta — a backward-looking regression" />
        <NumField label="Risk-free rate %" value={rf} set={setRf} step={0.25} />
        <NumField label="Equity risk premium %" value={erp} set={setErp} step={0.25}
                  hint="Not observable — this is the assumption that moves the answer most" />
        <NumField label="Pre-tax cost of debt %" value={costDebt} set={setCostDebt} step={0.25} />
        <NumField label="Extra risk premium %" value={premium} set={setPremium} step={0.25}
                  hint="Size, country or company-specific risk added to the cost of equity" />
        <label className="flex flex-col gap-1">
          <span className="label-xs flex items-center gap-1.5 flex-wrap">
            <span>Tax rate % — {fmtNum(tax, 1)}</span>
            {/* Where this number came from. A rate the company actually paid
                and a government's headline rate are different claims, and the
                slider looked identical either way. */}
            <span className={`text-[9px] px-1 py-px rounded border uppercase tracking-wider ${
              taxTouched ? "border-amber/50 text-amber"
                : taxRate?.source === "filed" ? "border-green/50 text-green"
                : "border-line2 text-mut"}`}
                  title={taxTouched
                    ? "Your value — nothing will overwrite it"
                    : taxRate?.read}>
              {taxTouched ? "yours"
                : taxRate?.source === "filed" ? "filed" : "statutory"}
            </span>
            {taxTouched && taxRate && (
              <button type="button"
                      onClick={() => { setTaxTouched(false); setTax(taxRate.pct); }}
                      className="text-[9px] text-mut hover:text-amber underline">
                reset to {fmtNum(taxRate.pct, 1)}%
              </button>
            )}
          </span>
          <input type="range" min={0} max={50} value={tax} step={0.1}
                 onChange={(e) => { setTaxTouched(true); setTax(parseFloat(e.target.value)); }}
                 className="accent-amber mt-1.5" />
          {taxRate && !taxTouched && (
            <span className="text-[10px] text-mut leading-relaxed">{taxRate.read}</span>
          )}
        </label>
      </div>

      {flags.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-4">
          {flags.map((f) => (
            <div key={f.text}
                 className={`flex items-start gap-2 text-[10.5px] leading-relaxed ${
                   f.severity === "warn" ? "text-red" : "text-amber/90"}`}>
              <AlertTriangle size={12} className="shrink-0 mt-[1px]" />
              <span>{f.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
        <MetricCard label="Cost of equity (CAPM)" value={`${fmtNum(r.costOfEquity, 2)}%`} />
        <MetricCard label="After-tax cost of debt" value={`${fmtNum(r.afterTaxDebt, 2)}%`} />
        <MetricCard label="Capital weights (E / D)"
                    value={r.we != null
                      ? `${fmtNum(r.we * 100, 0)}% / ${fmtNum(r.wd! * 100, 0)}%` : "—"} />
        <MetricCard label="WACC"
                    value={r.wacc != null ? `${fmtNum(r.wacc, 2)}%` : "—"}
                    tone="positive" />
      </div>

      {r.wacc != null && (
        <div className="text-[10.5px] text-mut mb-5 leading-relaxed">
          Equity contributes {fmtNum(r.equityContribution!, 2)} points and debt{" "}
          {fmtNum(r.debtContribution!, 2)}, on {humanNumber(r.capital, cur)} of
          total capital. Interest deductibility is worth{" "}
          {fmtNum(r.taxShield!, 2)} points — without it the WACC would be{" "}
          {fmtNum(r.wacc + r.taxShield!, 2)}%.
        </div>
      )}

      {/* The comparison the whole screen exists for. */}
      <SectionHeader title="Does the business clear its cost of capital?" />
      <div className="grid gap-2.5 mb-2"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <div className="hud p-3">
          <div className="label-xs">Return on capital employed</div>
          <div className="num text-lg mt-0.5 text-txt">
            {roce != null ? `${fmtNum(roce * 100, 1)}%` : "—"}
          </div>
        </div>
        <div className="hud p-3">
          <div className="label-xs">Cost of capital</div>
          <div className="num text-lg mt-0.5 text-txt">
            {r.wacc != null ? `${fmtNum(r.wacc, 1)}%` : "—"}
          </div>
        </div>
        <div className="hud p-3">
          <div className="label-xs">Spread</div>
          <div className={`num text-lg mt-0.5 ${
            spread.spread == null ? "text-mut"
              : spread.verdict === "creating" ? "text-green"
              : spread.verdict === "destroying" ? "text-red" : "text-txt"}`}>
            {spread.spread == null
              ? "—"
              : `${spread.spread >= 0 ? "+" : ""}${fmtNum(spread.spread, 1)} pts`}
          </div>
          <div className="text-[10px] text-mut mt-1 capitalize">{spread.verdict}</div>
        </div>
      </div>
      <Note>{spread.read}</Note>

      {/* Sensitivity: the honest precision of a single-point WACC. */}
      {grid && (
        <div className="mt-6">
          <SectionHeader
            title="Sensitivity"
            actions={
              <div className="flex items-center gap-2 text-[11px] flex-wrap">
                <label className="flex items-center gap-1.5">
                  <span className="text-mut">Rows</span>
                  <select value={rowAxis} onChange={(e) => setRowAxis(e.target.value as Axis)}
                          className="input-bare py-0.5 text-[11px]">
                    {AXES.filter((a) => a.key !== colAxis).map((a) => (
                      <option key={a.key} value={a.key}>{a.label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-mut">Columns</span>
                  <select value={colAxis} onChange={(e) => setColAxis(e.target.value as Axis)}
                          className="input-bare py-0.5 text-[11px]">
                    {AXES.filter((a) => a.key !== rowAxis).map((a) => (
                      <option key={a.key} value={a.key}>{a.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            }
          />
          <div className="overflow-x-auto">
            <table className="text-[11px] num">
              <thead>
                <tr>
                  <th className="text-left font-normal label-xs py-1.5 pr-3 whitespace-nowrap">
                    {axisLabel(rowAxis)} ↓ / {axisLabel(colAxis)} →
                  </th>
                  {grid.cols.map((c, ci) => (
                    <th key={c} className={`font-normal py-1.5 px-2.5 text-right whitespace-nowrap ${
                      ci === grid.centreCol ? "text-amber" : "text-mut"}`}>
                      {tickLabel(colAxis, c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((rw, ri) => (
                  <tr key={rw}>
                    <td className={`py-1.5 pr-3 whitespace-nowrap ${
                      ri === grid.centreRow ? "text-amber" : "text-mut"}`}>
                      {tickLabel(rowAxis, rw)}
                    </td>
                    {grid.cols.map((c, ci) => {
                      const v = grid.wacc[ri][ci];
                      const isCentre = ri === grid.centreRow && ci === grid.centreCol;
                      return (
                        <td key={c}
                            className={`py-1.5 px-2.5 text-right whitespace-nowrap ${
                              isCentre ? "text-amber font-semibold" : "text-txt"}`}
                            // Green where the discount rate is LOWER than the
                            // centre (a higher valuation), red where it's
                            // higher. Saturating at 2 points, which is about
                            // the width of a plausible disagreement.
                            style={{ background: centre != null && v != null
                              ? tintBg(centre - v, 2) : undefined }}>
                          {v == null ? "—" : `${fmtNum(v, 2)}%`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* What the rate actually does to a valuation. */}
      <div className="mt-6">
        <SectionHeader title="What this discount rate implies" />
        <div className="flex flex-wrap items-end gap-4 mb-2.5">
          <label className="flex flex-col gap-1 min-w-[220px]">
            <span className="label-xs">Perpetual growth % — {fmtNum(growth, 1)}</span>
            <input type="range" min={0} max={8} step={0.25} value={growth}
                   onChange={(e) => setGrowth(parseFloat(e.target.value))}
                   className="accent-amber" />
          </label>
          <div className="hud p-3">
            <div className="label-xs">Terminal multiple on cash flow</div>
            <div className={`num text-lg mt-0.5 ${
              implied.multiple == null ? "text-mut" : "text-txt"}`}>
              {implied.multiple == null ? "—" : `${fmtNum(implied.multiple, 1)}x`}
            </div>
          </div>
        </div>
        <Note>
          {implied.problem
            ? implied.problem
            : `At a ${fmtNum(r.wacc ?? 0, 1)}% cost of capital and ${fmtNum(growth, 1)}% `
              + `perpetual growth, terminal cash flow is worth `
              + `${fmtNum(implied.multiple!, 1)}x. That is where a discount rate `
              + "becomes real: 100bp on either input moves the multiple by "
              + "roughly a fifth, and most of a DCF's value sits in the "
              + "terminal figure."}
        </Note>
      </div>

      <div className="mt-4">
        <Note>{waccNote(active, grid)}</Note>
      </div>
      <Methodology id="wacc" className="mt-3" />
    </div>
  );
}
