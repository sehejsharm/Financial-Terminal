"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Info } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { Methodology } from "@/components/Methodology";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { ScrollX } from "@/components/ScrollX";
import { Note } from "@/components/ui";
import { api, type Statement } from "@/lib/api";
import {
  cagr, chronological, coverageNote, qualityFlags, RATIOS, ratioSeries,
  seriesFor, yoy, type Flag, type Statementish, type Statements,
} from "@/lib/statementAnalysis";
import { useAsync } from "@/lib/useAsync";
import { fmtNum, humanNumber } from "@/lib/utils";

/**
 * FA — financial statements, and what they say.
 *
 * This used to print whatever rows the provider returned, in the provider's
 * order, with no growth, no margins, no ratios and no way to see whether the
 * numbers were improving. Reading it meant doing the same arithmetic by hand
 * every single time.
 *
 * Now the three statements load together, because most of what is worth
 * knowing needs two of them at once: return on equity, cash conversion, net
 * debt to EBITDA. On top of the raw values there are two more ways to read
 * each statement — as a share of revenue, and as period-on-period growth —
 * plus a ratio sheet and a short list of quality flags.
 */

const TABS = [
  { key: "income", label: "Income" },
  { key: "balance", label: "Balance sheet" },
  { key: "cashflow", label: "Cash flow" },
  { key: "ratios", label: "Ratios" },
  { key: "quality", label: "Quality" },
] as const;
type Tab = typeof TABS[number]["key"];

const MODES = [
  { key: "value", label: "Values", hint: "As reported" },
  { key: "common", label: "% of revenue", hint: "Common size — every line as a share of revenue" },
  { key: "growth", label: "Growth", hint: "Period on period" },
] as const;
type Mode = typeof MODES[number]["key"];

/** Lines worth emphasising: the ones a reader looks for first. */
const KEY_LINES = new Set([
  "revenue", "total revenue", "gross profit", "operating income", "net income",
  "ebitda", "total assets", "total debt", "shareholders' equity",
  "stockholders equity", "operating cash flow", "free cash flow",
]);

/**
 * A line for a series.
 *
 * `tone` exists because "up" is not the same as "good": rising leverage and
 * rising margin are opposite news drawn by the same code. When the caller
 * knows which direction is favourable it passes a tone and the line inherits
 * that colour; otherwise the line just shows the shape in a neutral colour.
 *
 * Colouring by direction-of-travel alone — which this did at first — painted
 * a debt-to-equity ratio going from 0.50x to 0.60x bright green.
 */
function Spark({ values, tone }: {
  values: (number | null)[];
  tone?: "good" | "bad" | null;
}) {
  const pts = values.filter((v): v is number => v != null);
  if (pts.length < 2) return <span className="text-mut text-[10px]">—</span>;
  const min = Math.min(...pts, 0), max = Math.max(...pts, 0);
  const span = max - min || 1;
  const W = 56, H = 14;
  const step = W / (values.length - 1);
  const d = values.map((v, i) =>
    (v == null ? null : `${i * step},${H - ((v - min) / span) * H}`))
    .filter(Boolean).join(" ");
  const stroke = tone === "good" ? "rgb(var(--c-green))"
    : tone === "bad" ? "rgb(var(--c-red))"
    : "rgb(var(--c-mut))";
  return (
    <svg width={W} height={H} className="inline-block align-middle" aria-hidden>
      <polyline points={d} fill="none" strokeWidth={1.25} stroke={stroke} />
    </svg>
  );
}

function QualityPanel({ flags, periods }: { flags: Flag[]; periods: number }) {
  if (periods < 3) {
    return (
      <div className="panel-2 p-4 text-xs text-mut">
        Quality checks need at least three comparable periods; this listing has{" "}
        <span className="num text-txt">{periods}</span>. Two points is a line,
        not a trend, and flagging on a single comparison produces noise.
      </div>
    );
  }
  if (!flags.length) {
    return (
      <div className="panel-2 p-4 text-xs">
        <span className="text-green">Nothing flagged.</span>
        <span className="text-mut">
          {" "}None of the checks fired: cash conversion, gross-margin trend,
          leverage trend, current ratio, interest cover and effective tax rate.
          That is the absence of specific warnings, not a verdict on the
          business.
        </span>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {flags.map((f) => (
        <div key={f.title} className="panel-2 p-3.5">
          <div className="flex items-start gap-2">
            {f.level === "warn"
              ? <AlertTriangle size={13} className="text-red mt-0.5 shrink-0" />
              : <Info size={13} className="text-amber mt-0.5 shrink-0" />}
            <div className="min-w-0">
              <div className={`text-[12.5px] ${f.level === "warn" ? "text-red" : "text-amber"}`}>
                {f.title}
              </div>
              <div className="text-[11px] text-mut mt-1 leading-relaxed">{f.detail}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Financials({ ticker, currency }: { ticker: string; currency: string }) {
  const [tab, setTab] = useState<Tab>("income");
  const [mode, setMode] = useState<Mode>("value");
  const [quarterly, setQuarterly] = useState(false);
  const freshRef = useRef(false);

  // All three statements at once. The ratios that matter — return on equity,
  // cash conversion, net debt to EBITDA — each need two of them, and fetching
  // per tab meant the ratio sheet could never exist.
  const { data: meta, error, busy, retry, serverFault } = useAsync<{
    statements: Statements; fetchedAt: number | null;
  }>(
    async () => {
      const fresh = freshRef.current;
      freshRef.current = false;
      const [inc, bal, cf] = await Promise.all(
        (["income", "balance", "cashflow"] as const).map((k) =>
          api.statement(ticker, k, quarterly, { fresh })
            .catch(() => ({ data: null, fetchedAt: null }))),
      );
      return {
        statements: {
          income: inc.data as Statement | null,
          balance: bal.data as Statement | null,
          cashflow: cf.data as Statement | null,
        },
        fetchedAt: inc.fetchedAt ?? bal.fetchedAt ?? cf.fetchedAt,
      };
    },
    [ticker, quarterly],
  );

  const st: Statements = meta?.statements ?? { income: null, balance: null, cashflow: null };
  const ratios = useMemo(() => ratioSeries(st), [st]);
  const flags = useMemo(() => qualityFlags(st), [st]);

  const active: Statementish | null =
    tab === "income" ? st.income
      : tab === "balance" ? st.balance
      : tab === "cashflow" ? st.cashflow
      : null;

  const cols = useMemo(() => (active ? chronological(active.columns) : []), [active]);
  const revenue = useMemo(() => seriesFor(st.income, "revenue", cols), [st.income, cols]);
  const perYear = quarterly ? 4 : 1;

  function exportCsv() {
    const rows: string[][] = [];
    if (tab === "ratios") {
      rows.push(["Ratio", ...ratios.columns]);
      for (const r of RATIOS) {
        rows.push([r.label, ...ratios.values[r.key].map(
          (v) => (v == null ? "" : v.toFixed(4)))]);
      }
    } else if (active) {
      rows.push([`Line (${currency})`, ...cols]);
      for (const r of active.rows) {
        rows.push([r.line, ...cols.map((c) => {
          const v = r[c];
          return typeof v === "number" ? String(v) : "";
        })]);
      }
    }
    const csv = rows.map((r) => r.map((c) =>
      (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${ticker}-${tab}-${quarterly ? "quarterly" : "annual"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const anyData = !!(st.income?.rows.length || st.balance?.rows.length
    || st.cashflow?.rows.length);
  const source = (st.income as Statement | null)?.source
    || (st.balance as Statement | null)?.source
    || (st.cashflow as Statement | null)?.source;

  return (
    <div>
      <div role="tablist"
           className="flex flex-wrap items-center gap-1 mb-3 border-b border-line2">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} role="tab"
                  aria-selected={tab === t.key}
                  className={`px-3 py-2 text-xs uppercase tracking-wider border-b-2 -mb-px
                              transition-colors ${
                    tab === t.key ? "border-amber text-amber"
                      : "border-transparent text-mut hover:text-txt"}`}>
            {t.label}
            {t.key === "quality" && flags.length > 0 && (
              <span className="ml-1.5 text-[9px] px-1 rounded bg-red/20 text-red">
                {flags.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {tab !== "ratios" && tab !== "quality" && (
          <div className="flex items-center gap-1">
            {MODES.map((m) => (
              <button key={m.key} onClick={() => setMode(m.key)}
                      aria-pressed={mode === m.key} title={m.hint}
                      className={`px-2 py-1 rounded border text-[10px] uppercase
                                  tracking-wider transition-colors ${
                        mode === m.key ? "border-amber text-amber bg-amber/10"
                          : "border-line2 text-mut hover:text-txt"}`}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1" />
        <DataAge at={meta?.fetchedAt ?? null}
                 onRefresh={() => { freshRef.current = true; retry(); }} busy={busy} />
        <button onClick={() => setQuarterly((v) => !v)}
                className={`btn ${quarterly ? "btn-primary" : "btn-ghost"} !py-1 text-[11px]`}>
          {quarterly ? "Quarterly" : "Annual"}
        </button>
        {anyData && (
          <button onClick={exportCsv}
                  className="btn-ghost !py-1 text-[11px] flex items-center gap-1.5">
            <Download size={11} /> CSV
          </button>
        )}
      </div>

      {busy && <PanelLoading label="Loading statements…" rows={6} />}
      {error && !busy && (
        <PanelError error={error} retry={retry} serverFault={serverFault} />
      )}

      {!busy && !error && !anyData && (
        <div className="panel-2 p-4 text-mut text-sm">
          {(st.income as Statement | null)?.note || (
            <>Statements for <span className="text-amber">{ticker}</span> aren&apos;t
            available from the configured data providers.</>
          )}
        </div>
      )}

      {!busy && !error && anyData && (
        <>
          <div className="text-[10.5px] text-mut mb-2">
            {source && <>Source: {source}. </>}{coverageNote(st)}
          </div>

          {tab === "quality" && (
            <QualityPanel flags={flags} periods={ratios.columns.length} />
          )}

          {tab === "ratios" && (
            <ScrollX className="panel">
              <table className="w-full text-[11.5px]">
                <thead className="text-mut uppercase tracking-wider">
                  <tr className="border-b border-line2">
                    <th className="text-left px-3 py-2 font-medium">Ratio</th>
                    <th className="text-left px-3 py-2 font-medium">Trend</th>
                    {ratios.columns.map((c) => (
                      <th key={c} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                        {c.slice(0, 10)}
                      </th>
                    ))}
                  </tr>
                </thead>
                {["Margins", "Returns", "Liquidity", "Leverage", "Efficiency & cash"]
                  .map((group) => {
                    const defs = RATIOS.filter((r) => r.group === group);
                    if (!defs.length) return null;
                    return (
                      <tbody key={group}>
                        <tr className="bg-panel2/60">
                          <td colSpan={ratios.columns.length + 2}
                              className="px-3 py-1 label-xs border-y border-line2">
                            {group}
                          </td>
                        </tr>
                        {defs.map((r) => {
                          const series = ratios.values[r.key] ?? [];
                          const first = series.find((v) => v != null) ?? null;
                          const lastVal = [...series].reverse().find((v) => v != null) ?? null;
                          // Coloured only where the metric HAS a good
                          // direction. A tax rate or capex intensity moving is
                          // neither improvement nor deterioration.
                          const better = r.direction === "none" || first == null
                            || lastVal == null ? null
                            : r.direction === "up" ? lastVal >= first : lastVal <= first;
                          return (
                            <tr key={r.key} className="border-b border-line/60 hover:bg-panel">
                              <td className="px-3 py-1.5 text-txt whitespace-nowrap"
                                  title={r.formula}>
                                {r.label}
                                <span className="text-mut text-[9.5px] ml-1.5">{r.formula}</span>
                              </td>
                              <td className="px-3 py-1.5">
                                <Spark values={series}
                                       tone={better == null ? null
                                         : better ? "good" : "bad"} />
                              </td>
                              {series.map((v, i) => (
                                <td key={i} className="px-3 py-1.5 num text-right">
                                  {v == null ? <span className="text-mut">—</span>
                                    : r.unit === "%" ? `${fmtNum(v, 1)}%`
                                    : `${fmtNum(v, 2)}x`}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    );
                  })}
              </table>
            </ScrollX>
          )}

          {active && active.rows.length > 0 && tab !== "ratios" && tab !== "quality" && (
            <ScrollX className="panel">
              <table className="w-full text-xs">
                <thead className="text-mut uppercase tracking-wider">
                  <tr className="border-b border-line2">
                    <th className="text-left px-3 py-2 font-medium">
                      Line item {mode === "value" ? `(${currency})` : ""}
                    </th>
                    <th className="text-left px-3 py-2 font-medium">Trend</th>
                    {cols.map((c) => (
                      <th key={c} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                        {c.slice(0, 10)}
                      </th>
                    ))}
                    {mode === "value" && (
                      <th className="text-right px-3 py-2 font-medium whitespace-nowrap"
                          title="Compound annual growth across the periods shown">
                        CAGR
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {active.rows.map((r, i) => {
                    const raw = cols.map((c) => {
                      const v = r[c];
                      return typeof v === "number" ? v : null;
                    });
                    const shown = mode === "growth" ? yoy(raw)
                      : mode === "common"
                        ? raw.map((v, j) => (v == null || !revenue[j] ? null
                          : (v / revenue[j]!) * 100))
                        : raw;
                    const key = KEY_LINES.has(r.line.toLowerCase());
                    const g = mode === "value" ? cagr(raw, perYear) : null;
                    return (
                      <tr key={i}
                          className={`border-b border-line/60 hover:bg-panel ${
                            key ? "bg-panel2/40" : ""}`}>
                        <td className={`px-3 py-1.5 whitespace-nowrap ${
                          key ? "text-txt font-medium" : "text-txt/80"}`}>
                          {r.line}
                        </td>
                        <td className="px-3 py-1.5"><Spark values={raw} /></td>
                        {shown.map((v, j) => (
                          <td key={j} className={`px-3 py-1.5 num text-right ${
                            mode === "growth" && v != null
                              ? (v >= 0 ? "text-green" : "text-red") : "text-txt/90"}`}>
                            {v == null ? <span className="text-mut">—</span>
                              : mode === "value" ? humanNumber(v)
                              : `${v >= 0 && mode === "growth" ? "+" : ""}${fmtNum(v, 1)}%`}
                          </td>
                        ))}
                        {mode === "value" && (
                          <td className={`px-3 py-1.5 num text-right ${
                            g == null ? "text-mut" : g >= 0 ? "text-green" : "text-red"}`}>
                            {g == null ? "—" : `${g >= 0 ? "+" : ""}${fmtNum(g, 1)}%`}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollX>
          )}

          {active && active.rows.length === 0 && tab !== "ratios" && tab !== "quality" && (
            <div className="panel-2 p-4 text-mut text-sm">
              {(active as Statement).note || `No ${tab} statement available for ${ticker}.`}
            </div>
          )}

          {mode === "common" && tab !== "ratios" && tab !== "quality" && (
            <Note>
              <span className="block mt-2">
                Every line divided by revenue for the same period, including on
                the balance sheet and cash flow — the convention for comparing
                a company with itself over time and with peers of a different
                size. A period where revenue is missing shows blank rather than
                a ratio against a neighbouring year.
              </span>
            </Note>
          )}

          <Methodology id="financials" className="mt-3" />
        </>
      )}
    </div>
  );
}
