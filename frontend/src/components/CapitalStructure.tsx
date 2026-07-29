"use client";

import { useMemo } from "react";

import { MetricCard } from "@/components/MetricCard";
import { Methodology } from "@/components/Methodology";
import { PanelEmpty, PanelError, PanelLoading } from "@/components/PanelStates";
import { Note } from "@/components/ui";
import { api, type CapStructure, type Statement } from "@/lib/api";
import {
  cagr, chronological, evMultiples, impliedShares, type Statements,
} from "@/lib/statementAnalysis";
import { useAsync } from "@/lib/useAsync";
import { curSymbol, fmtNum, humanNumber } from "@/lib/utils";

/**
 * CS — the capital stack.
 *
 * Was four cards and a two-segment bar: how much equity, how much debt.
 * True, and not what anyone needs it for. The two questions that matter are
 * what the whole enterprise costs relative to what it earns, and whether the
 * share count is going up or down — because a company buying back 3% a year
 * and one issuing 3% a year look identical on a debt/equity bar and are
 * opposite investments.
 *
 * The share-count series is derived, not fetched: no provider gives one, but
 * net income divided by diluted EPS recovers it exactly from two reported
 * lines.
 */
export function CapitalStructureView({ ticker }: { ticker: string }) {
  const { data, error, busy, retry, serverFault } = useAsync<{
    cap: CapStructure | null; statements: Statements;
  }>(
    async () => {
      const [cap, inc, bal, cf] = await Promise.all([
        api.capitalStructure(ticker),
        ...(["income", "balance", "cashflow"] as const).map((k) =>
          api.statement(ticker, k, false).catch(() => ({ data: null }))),
      ]);
      return {
        cap: cap as CapStructure,
        statements: {
          income: (inc as { data: Statement | null }).data,
          balance: (bal as { data: Statement | null }).data,
          cashflow: (cf as { data: Statement | null }).data,
        },
      };
    },
    [ticker],
  );

  const cap = data?.cap ?? null;
  const st = data?.statements ?? { income: null, balance: null, cashflow: null };

  const ev = useMemo(() => evMultiples(cap ?? {}, st), [cap, st]);
  const incCols = useMemo(
    () => (st.income ? chronological(st.income.columns) : []), [st.income]);
  const shares = useMemo(() => impliedShares(st.income, incCols), [st.income, incCols]);
  const dilution = useMemo(() => cagr(shares), [shares]);

  if (busy) return <PanelLoading label="Loading capital structure…" rows={5} />;
  if (error) return <PanelError error={error} retry={retry} serverFault={serverFault} />;
  if (!cap) return null;

  if (cap.market_cap == null && cap.total_debt == null && cap.cash == null) {
    return (
      <PanelEmpty retry={retry}>
        Capital-structure inputs aren&apos;t covered by free data for this listing.
      </PanelEmpty>
    );
  }

  const cur = curSymbol(cap.currency);
  const debt = cap.total_debt ?? 0;
  const cash = cap.cash ?? 0;
  const equity = cap.market_cap ?? 0;
  const netDebt = debt - cash;
  const total = equity + Math.max(debt, 0) || 1;
  const equityPct = (equity / total) * 100;
  const debtPct = (Math.max(debt, 0) / total) * 100;
  const knownShares = shares.filter((v): v is number => v != null);

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <MetricCard label="Market cap (equity)" value={humanNumber(cap.market_cap, cur)} />
        <MetricCard label="Total debt" value={humanNumber(cap.total_debt, cur)} />
        <MetricCard label="Cash" value={humanNumber(cap.cash, cur)} />
        <MetricCard label="Net debt" value={humanNumber(netDebt, cur)}
                    tone={netDebt > 0 ? "negative" : "positive"} />
      </div>

      {/* What the whole enterprise costs against what it earns. These are the
          comparisons that survive a different capital structure, which is the
          entire reason to look at enterprise value rather than market cap. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Enterprise value" value={humanNumber(ev.ev, cur)}
                    title="Market cap + total debt − cash" />
        <MetricCard label="EV / EBITDA"
                    value={ev.evEbitda == null ? "—" : `${fmtNum(ev.evEbitda, 1)}x`} />
        <MetricCard label="EV / sales"
                    value={ev.evSales == null ? "—" : `${fmtNum(ev.evSales, 2)}x`} />
        <MetricCard label="EV / free cash flow"
                    value={ev.evFcf == null ? "—" : `${fmtNum(ev.evFcf, 1)}x`} />
      </div>

      <div className="heading mb-2">Enterprise value ≈ {humanNumber(ev.ev, cur)}</div>
      <div className="panel-2 p-4 mb-4">
        <div className="flex h-8 rounded overflow-hidden border border-line2 mb-2">
          <div className="bg-amber/80 flex items-center justify-center text-[10px] text-black font-bold"
               style={{ width: `${equityPct}%` }}>
            {equityPct > 12 ? "EQUITY" : ""}
          </div>
          <div className="bg-red/70 flex items-center justify-center text-[10px] text-white font-bold"
               style={{ width: `${debtPct}%` }}>
            {debtPct > 12 ? "DEBT" : ""}
          </div>
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-[11px] text-mut">
          <span>Equity {equityPct.toFixed(0)}%</span>
          <span>
            Debt {debtPct.toFixed(0)}%
            {ev.netDebtToEv != null && (
              <span className="ml-3">
                Net debt is {fmtNum(ev.netDebtToEv, 0)}% of enterprise value
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Dilution or buyback. Identical on the bar above, opposite for a
          holder: the same operating profit divided among more or fewer
          shares. */}
      <div className="heading mb-2">Share count</div>
      <div className="panel-2 p-4 mb-3">
        {knownShares.length < 2 ? (
          <div className="text-xs text-mut">
            The diluted share count can be recovered from net income and diluted
            EPS, and this listing carries fewer than two periods with both.
            Latest reported count:{" "}
            <span className="num text-txt">{humanNumber(cap.shares)}</span>.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2 mb-3">
              <div>
                <div className="label-xs">Implied diluted shares, latest</div>
                <div className="num text-lg text-txt">
                  {humanNumber(knownShares[knownShares.length - 1])}
                </div>
              </div>
              <div>
                <div className="label-xs">Change per year</div>
                <div className={`num text-lg ${
                  dilution == null ? "text-mut"
                    : dilution > 0.5 ? "text-red"
                    : dilution < -0.5 ? "text-green" : "text-txt"}`}>
                  {dilution == null ? "—"
                    : `${dilution >= 0 ? "+" : ""}${fmtNum(dilution, 2)}%`}
                </div>
              </div>
              <div className="text-[11px] text-mut max-w-md">
                {dilution == null ? null
                  : dilution > 0.5
                    ? "The count is rising: each share owns a shrinking slice, "
                      + "so earnings per share grow slower than earnings do."
                    : dilution < -0.5
                      ? "The count is falling: buybacks are adding to earnings "
                        + "per share on top of whatever the business does."
                      : "Broadly flat — neither buybacks nor issuance is moving "
                        + "per-share figures much."}
              </div>
            </div>
            {/* The bar column needs a DEFINITE height for a percentage
                height on its child to resolve against. Without the inner
                h-full the bars computed correctly and rendered as nothing. */}
            <div className="flex items-end gap-1 h-20">
              {shares.map((v, i) => {
                const max = Math.max(...knownShares);
                // Floor just below the smallest count rather than at zero:
                // share counts move by a few percent, and a zero-based axis
                // renders every year as the same full-height bar.
                const min = Math.min(...knownShares) * 0.98;
                const h = v == null ? 0 : ((v - min) / (max - min || 1)) * 100;
                return (
                  <div key={i}
                       className="flex-1 h-full flex flex-col justify-end items-center gap-1">
                    <div className="w-full bg-amber/60 rounded-sm shrink-0"
                         style={{ height: `${Math.max(6, h)}%` }}
                         title={v == null ? "no data" : humanNumber(v)} />
                    <span className="text-[9px] text-mut shrink-0">
                      {(incCols[i] ?? "").slice(2, 7)}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <Note>
        The share count above is <strong className="text-txt">derived</strong>:
        net income divided by diluted EPS, both as reported. That recovers the
        weighted-average diluted count for each period exactly, but it is a
        period average rather than a point-in-time count, so it lags a buyback
        or a placement by up to a year. Enterprise value uses today&apos;s
        market cap against the latest reported EBITDA, revenue and free cash
        flow, so every multiple mixes a live price with a stale denominator —
        which is the convention, and worth remembering when the last report is
        eleven months old.
      </Note>

      <Methodology id="financials" className="mt-3" />
    </div>
  );
}
