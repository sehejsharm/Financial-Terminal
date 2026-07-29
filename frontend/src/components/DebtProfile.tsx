"use client";

import { useMemo } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Methodology } from "@/components/Methodology";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { ScrollX } from "@/components/ScrollX";
import { Note } from "@/components/ui";
import { api, type CapStructure, type Snapshot, type Statement } from "@/lib/api";
import { ratioSeries, seriesFor, type Statements } from "@/lib/statementAnalysis";
import { useAsync } from "@/lib/useAsync";
import { curSymbol, fmtNum, humanNumber } from "@/lib/utils";

/**
 * DDIS — the debt picture.
 *
 * This was eight cards of today's numbers, which answers "how much debt" and
 * not the question anyone actually has, which is "is this getting better or
 * worse, and can they service it". Leverage at a point in time tells you
 * almost nothing; leverage across four years tells you what management has
 * been doing.
 *
 * Free data has no maturity ladder — no provider on the free tier publishes
 * debt by year of maturity — so that gap is stated rather than papered over.
 * What CAN be built from the statements is the trend, the coverage, and how
 * many years of free cash flow the net debt represents.
 */
export function DebtProfile({ ticker, snap }: { ticker: string; snap: Snapshot | null }) {
  const { data, error, busy, retry, serverFault } = useAsync<{
    cap: CapStructure | null; statements: Statements;
  }>(
    async () => {
      const [cap, inc, bal, cf] = await Promise.all([
        api.capitalStructure(ticker).catch(() => null),
        ...(["income", "balance", "cashflow"] as const).map((k) =>
          api.statement(ticker, k, false).catch(() => ({ data: null }))),
      ]);
      return {
        cap: cap as CapStructure | null,
        statements: {
          income: (inc as { data: Statement | null }).data,
          balance: (bal as { data: Statement | null }).data,
          cashflow: (cf as { data: Statement | null }).data,
        },
      };
    },
    [ticker],
  );

  const st = data?.statements ?? { income: null, balance: null, cashflow: null };
  const ratios = useMemo(() => ratioSeries(st), [st]);
  const cols = ratios.columns;

  const debtSeries = useMemo(() => seriesFor(st.balance, "totalDebt", cols), [st.balance, cols]);
  const cashSeries = useMemo(() => seriesFor(st.balance, "cash", cols), [st.balance, cols]);
  const fcfSeries = useMemo(() => seriesFor(st.cashflow, "freeCF", cols), [st.cashflow, cols]);
  const ocfSeries = useMemo(() => seriesFor(st.cashflow, "operatingCF", cols), [st.cashflow, cols]);
  const capexSeries = useMemo(() => seriesFor(st.cashflow, "capex", cols), [st.cashflow, cols]);

  if (busy) return <PanelLoading label="Loading debt profile…" rows={5} />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;

  const cap = data?.cap ?? null;
  const cur = curSymbol((cap?.currency || (snap?.currency as string)) ?? "USD");
  const netDebtNow = (cap?.total_debt ?? 0) - (cap?.cash ?? 0);

  // Years of free cash flow to clear the net debt. The single most useful
  // leverage number and one no provider reports: it turns an abstract
  // multiple into "at this rate, they clear it in N years".
  const latestFcf = [...fcfSeries].reverse().find((v) => v != null)
    ?? (() => {
      const o = [...ocfSeries].reverse().find((v) => v != null);
      const c = [...capexSeries].reverse().find((v) => v != null);
      return o != null && c != null ? o + c : null;
    })();
  const yearsToClear = latestFcf != null && latestFcf > 0 && netDebtNow > 0
    ? netDebtNow / latestFcf : null;

  const lastOf = (k: keyof typeof ratios.values) =>
    [...(ratios.values[k] ?? [])].reverse().find((v) => v != null) ?? null;
  const nd = lastOf("netDebtToEbitda");
  const ic = lastOf("interestCover");
  const de = lastOf("debtToEquity");

  const hasTrend = cols.length >= 2;

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <MetricCard label="Total debt" value={humanNumber(cap?.total_debt, cur)} />
        <MetricCard label="Cash" value={humanNumber(cap?.cash, cur)} />
        <MetricCard label="Net debt" value={humanNumber(netDebtNow, cur)}
                    tone={netDebtNow > 0 ? "negative" : "positive"} />
        <MetricCard
          label="Years of FCF to clear net debt"
          value={yearsToClear == null ? "—" : `${fmtNum(yearsToClear, 1)}y`}
          tone={yearsToClear == null ? "neutral"
            : yearsToClear > 5 ? "negative" : yearsToClear < 2 ? "positive" : "neutral"} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Net debt / EBITDA"
                    value={nd == null ? "—" : `${fmtNum(nd, 2)}x`}
                    tone={nd == null ? "neutral" : nd > 3 ? "negative" : nd < 1 ? "positive" : "neutral"} />
        <MetricCard label="Interest cover (inferred)"
                    value={ic == null ? "—" : `${fmtNum(ic, 1)}x`}
                    tone={ic == null ? "neutral" : ic < 3 ? "negative" : ic > 8 ? "positive" : "neutral"} />
        <MetricCard label="Debt / equity"
                    value={de == null ? "—" : `${fmtNum(de, 2)}x`}
                    tone={de == null ? "neutral" : de > 1.5 ? "negative" : "neutral"} />
        <MetricCard label="Current ratio"
                    value={fmtNum(lastOf("currentRatio") ?? (snap?.current_ratio as number), 2)} />
      </div>

      {hasTrend && (
        <>
          <div className="heading mb-2">How it has moved</div>
          <ScrollX className="panel mb-3">
            <table className="w-full text-[11.5px]">
              <thead className="text-mut uppercase tracking-wider">
                <tr className="border-b border-line2">
                  <th className="text-left px-3 py-2 font-medium">Measure</th>
                  {cols.map((c) => (
                    <th key={c} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                      {c.slice(0, 10)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ["Total debt", debtSeries, "money"],
                  ["Cash", cashSeries, "money"],
                  ["Net debt", cols.map((_, i) => {
                    const d = debtSeries[i], c = cashSeries[i];
                    return d == null || c == null ? null : d - c;
                  }), "money"],
                  ["Free cash flow", cols.map((_, i) => {
                    const f = fcfSeries[i];
                    if (f != null) return f;
                    const o = ocfSeries[i], c = capexSeries[i];
                    return o != null && c != null ? o + c : null;
                  }), "money"],
                  ["Net debt / EBITDA", ratios.values.netDebtToEbitda, "x"],
                  ["Interest cover", ratios.values.interestCover, "x"],
                  ["Debt / equity", ratios.values.debtToEquity, "x"],
                ] as [string, (number | null)[], "money" | "x"][]).map(([label, series, kind]) => (
                  <tr key={label} className="border-b border-line/60 hover:bg-panel">
                    <td className="px-3 py-1.5 text-txt whitespace-nowrap">{label}</td>
                    {cols.map((_, i) => {
                      const v = series?.[i] ?? null;
                      return (
                        <td key={i} className="px-3 py-1.5 num text-right text-txt/90">
                          {v == null ? <span className="text-mut">—</span>
                            : kind === "money" ? humanNumber(v, cur)
                            : `${fmtNum(v, 2)}x`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        </>
      )}

      <Note>
        Free data has no maturity ladder — no provider on the free tier
        publishes debt by year of maturity — so refinancing risk, the thing
        that actually breaks a levered balance sheet, cannot be shown here.
        What is above is the level, the trend and the coverage. Interest cover
        is inferred from the gap between operating and pre-tax income, which
        also contains other non-operating items; treat it as approximate.
        &ldquo;Years of FCF to clear net debt&rdquo; assumes the latest year&apos;s
        free cash flow repeats and that every rupee of it goes to repayment,
        which no company does.
      </Note>

      <Methodology id="financials" className="mt-3" />
    </div>
  );
}
