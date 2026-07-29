"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";

import { Methodology } from "@/components/Methodology";
import { ScrollX } from "@/components/ScrollX";
import { EmptyState, Note, SectionHeader } from "@/components/ui";
import { api, type LiquidityBook, type Snapshot } from "@/lib/api";
import {
  byCountry, concentration, exposures, hhiBand, riskNote, SINGLE_POINT_PCT,
  tradePlan,
} from "@/lib/chainRisk";
import type { MergedEntity } from "@/lib/valueChainGraph";
import { buildRows, type QuoteLike } from "@/lib/valueChainTable";
import { fmtNum, humanNumber } from "@/lib/utils";

/**
 * The exposure and execution view — what turns a relationship map into
 * something you could size a position against.
 *
 * A picture of who supplies whom is a research artefact. Committing real
 * money against it needs four more answers on the same screen: how
 * concentrated the chain is, what each relationship is worth in money, where
 * that exposure physically sits, and whether the resulting trade can be
 * executed at the intended size.
 *
 * The last one is the part every other supply-chain screen leaves out. An
 * idea that requires three weeks of buying in a name that reprices on the
 * news is not the same idea at $50m and at $1bn, and the difference is
 * arithmetic anyone can check: notional over average daily value traded.
 */

const SIZES = [
  { id: 1e8, label: "$100m" },
  { id: 5e8, label: "$500m" },
  { id: 1e9, label: "$1bn" },
  { id: 5e9, label: "$5bn" },
];

const VERDICT_TONE: Record<string, string> = {
  "same day": "text-green",
  days: "text-green",
  weeks: "text-amber",
  months: "text-red",
  "untradable at size": "text-red",
  unknown: "text-mut",
};

function Metric({ label, value, sub, tone = "text-txt", title }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  tone?: string; title?: string;
}) {
  return (
    <div className="hud p-3 min-w-0" title={title}>
      <div className="label-xs truncate">{label}</div>
      <div className={`num text-lg mt-0.5 leading-tight ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-mut mt-1 leading-relaxed">{sub}</div>}
    </div>
  );
}

export function ExposurePanel({
  entities, subject, generatedAt, quotes, snapshot,
}: {
  entities: MergedEntity[];
  subject: string;
  generatedAt?: string | null;
  quotes?: Record<string, QuoteLike | null>;
  /** The subject's own financials, for converting shares into money. */
  snapshot?: Snapshot | null;
}) {
  const [notional, setNotional] = useState(1e9);
  const [liq, setLiq] = useState<LiquidityBook | null>(null);
  const [liqErr, setLiqErr] = useState<string | null>(null);
  const [liqBusy, setLiqBusy] = useState(false);

  const rows = useMemo(
    () => buildRows(entities, { quotes, generatedAt }), [entities, quotes, generatedAt]);

  const tickers = useMemo(() => Array.from(new Set(
    rows.map((r) => r.ticker).filter((t): t is string => !!t),
  )).slice(0, 30), [rows]);

  // Liquidity is a per-name history fetch, so it is explicit rather than
  // automatic — and it is the one number here that cannot be derived from
  // the map alone.
  function loadLiquidity() {
    if (!tickers.length) return;
    setLiqBusy(true); setLiqErr(null);
    api.liquidity(tickers, 1e9, 0.15)
      .then(setLiq)
      .catch((e) => setLiqErr(e?.detail || "Could not load liquidity."))
      .finally(() => setLiqBusy(false));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLiq(null); setLiqErr(null); }, [subject]);

  const financials = {
    revenue: (snapshot?.revenue as number | undefined) ?? null,
    cogs: (snapshot?.cost_of_revenue as number | undefined) ?? null,
  };
  const { rows: exp, basis } = useMemo(
    () => exposures(rows, financials),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, financials.revenue, financials.cogs]);
  const conc = useMemo(() => concentration(rows), [rows]);
  const countries = useMemo(() => byCountry(exp), [exp]);
  const plan = useMemo(
    () => tradePlan(exp, liq?.names ?? {}, notional), [exp, liq, notional]);

  if (!rows.length) {
    return <EmptyState title="Nothing to analyse — this map has no relationships." />;
  }

  const cur = (snapshot?.currency as string) || "USD";
  const money = (v: number | null) => (v == null ? "—" : humanNumber(v, cur === "INR" ? "₹" : "$"));

  return (
    <div className="grid gap-5">
      {/* ── concentration ─────────────────────────────────────────────── */}
      <section>
        <SectionHeader title="Concentration" note={riskNote(conc, countries)} />
        <div className="grid gap-2.5"
             style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <Metric label="Largest single counterparty"
                  value={conc.top1 == null ? "—" : `${fmtNum(conc.top1, 1)}%`}
                  tone={conc.top1 != null && conc.top1 >= 40 ? "text-red" : "text-txt"}
                  sub="of the quantified exposure" />
          <Metric label="Top three combined"
                  value={conc.top3 == null ? "—" : `${fmtNum(conc.top3, 1)}%`}
                  tone={conc.top3 != null && conc.top3 >= 70 ? "text-amber" : "text-txt"} />
          <Metric label="HHI"
                  value={conc.hhi ?? "—"}
                  sub={hhiBand(conc.hhi)}
                  title="Herfindahl index over the quantified exposure shares. Above 2,500 is the competition-authority threshold for highly concentrated." />
          <Metric label="Effective counterparties"
                  value={conc.effectiveCount ?? "—"}
                  sub={`from ${conc.quantified} quantified of ${conc.total}`}
                  title="1 / Σ(share²). Ten suppliers where one carries 70% behave like two." />
          <Metric label="Single points of failure"
                  value={conc.singlePoints.length || "0"}
                  tone={conc.singlePoints.length ? "text-red" : "text-green"}
                  sub={`above ${SINGLE_POINT_PCT}% on their own`} />
        </div>

        {conc.singlePoints.length > 0 && (
          <div className="panel-2 p-3 mt-2.5 text-[11px]">
            <div className="flex items-start gap-2">
              <AlertTriangle size={13} className="text-red mt-0.5 shrink-0" />
              <div>
                <span className="text-txt">
                  {conc.singlePoints.map((s) => s.name).join(", ")}
                </span>
                <span className="text-mut">
                  {" "}— each above {SINGLE_POINT_PCT}% of {subject}&apos;s quantified
                  exposure on its own. A disruption at any one of these is not
                  absorbed by the rest of the chain; it passes straight through.
                </span>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── money at risk ─────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Exposure in money"
          count={`${exp.length} valued`}
          note={basis === "financials"
            ? `Shares applied to ${subject}'s reported revenue and cost of revenue.`
            : basis === "model"
              ? "The subject's own revenue and cost of revenue are not available "
                + "from the free providers, so these are the model's own estimated "
                + "relationship values — a weaker basis, and one to verify before use."
              : "Nothing in this map carries a figure that can be turned into money."} />
        {exp.length === 0 ? (
          <EmptyState title="No relationship in this map carries a quantified share." />
        ) : (
          <ScrollX className="panel">
            <table className="w-full text-[11.5px]">
              <thead className="text-mut uppercase tracking-wider">
                <tr className="border-b border-line2">
                  <th className="text-left px-2.5 py-2 font-medium">Counterparty</th>
                  <th className="text-left px-2.5 py-2 font-medium">Role</th>
                  <th className="text-left px-2.5 py-2 font-medium">Listing</th>
                  <th className="text-right px-2.5 py-2 font-medium">Share</th>
                  <th className="text-right px-2.5 py-2 font-medium">At risk</th>
                  <th className="text-left px-2.5 py-2 font-medium">Basis</th>
                </tr>
              </thead>
              <tbody>
                {exp.map((r) => (
                  <tr key={r.name} className="border-b border-line/60 hover:bg-panel">
                    <td className="px-2.5 py-1.5">
                      <span className="flex items-center gap-1.5">
                        <span className="text-txt">{r.name}</span>
                        {r.confidence === "verified" && (
                          <ShieldCheck size={10} className="text-green shrink-0" />
                        )}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-mut">{r.role}</td>
                    <td className="px-2.5 py-1.5 num text-mut">{r.country ?? "—"}</td>
                    <td className="px-2.5 py-1.5 num text-right">
                      {r.pct ? `${fmtNum(r.pct, 1)}%` : <span className="text-mut">—</span>}
                    </td>
                    <td className="px-2.5 py-1.5 num text-right text-txt">{money(r.atRisk)}</td>
                    <td className={`px-2.5 py-1.5 ${r.confidence === "verified" ? "text-green" : "text-mut"}`}>
                      {r.confidence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        )}
      </section>

      {/* ── geography ─────────────────────────────────────────────────── */}
      {countries.length > 0 && (
        <section>
          <SectionHeader
            title="Where the exposure sits"
            note="By listing venue, which is the best proxy the free data supports —
                  it is where a counterparty TRADES, not necessarily where it
                  manufactures. A jurisdiction concentration here is a real risk
                  and an imprecise measurement at the same time." />
          <div className="grid gap-1.5">
            {countries.map((c) => (
              <div key={c.country} className="flex items-center gap-2 text-[11px]">
                <span className="num w-24 shrink-0 text-txt truncate" title={c.names.join(", ")}>
                  {c.country}
                </span>
                <span className="relative flex-1 h-2.5 bg-line/50 rounded-sm overflow-hidden min-w-[80px]">
                  <span className="absolute inset-y-0 left-0 bg-amber/70"
                        style={{ width: `${Math.min(100, c.pct)}%` }} />
                </span>
                <span className="num w-14 text-right text-txt">{fmtNum(c.pct, 1)}%</span>
                <span className="num w-20 text-right text-mut">{money(c.atRisk)}</span>
                <span className="text-mut w-10 text-right">{c.names.length}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── execution ─────────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Can this be traded at size"
          actions={
            <div className="flex items-center gap-1.5">
              {SIZES.map((s) => (
                <button key={s.id} onClick={() => setNotional(s.id)}
                        aria-pressed={notional === s.id}
                        className={`px-2 py-0.5 rounded border text-[10px] uppercase
                                    tracking-wider transition-colors ${
                          notional === s.id
                            ? "border-amber text-amber bg-amber/10"
                            : "border-line2 text-mut hover:text-txt"}`}>
                  {s.label}
                </button>
              ))}
            </div>
          }
          note="The notional is spread across the listed counterparties in
                proportion to their exposure, then each leg is checked against
                its own average daily value traded. This is the question that
                decides whether an analysis is actionable at a given size." />

        {!liq && !liqBusy && (
          <div className="panel-2 p-4 flex flex-wrap items-center gap-3">
            <span className="text-xs text-mut flex-1 min-w-[220px]">
              {tickers.length
                ? `Reads 3 months of daily bars for ${tickers.length} listed `
                  + "counterparties. Not automatic — it is the heaviest fetch on "
                  + "this screen."
                : "None of the counterparties in this map carry a ticker, so there "
                  + "is nothing to size."}
            </span>
            <button onClick={loadLiquidity} disabled={!tickers.length}
                    className="btn-primary text-xs disabled:opacity-40">
              Check tradability
            </button>
          </div>
        )}
        {liqBusy && (
          <div className="panel-2 p-4 text-mut text-xs flex items-center gap-2">
            <span className="mb-ping w-1.5 h-1.5 rounded-full bg-amber inline-block" />
            Reading daily bars for {tickers.length} names…
          </div>
        )}
        {liqErr && (
          <div className="panel-2 p-4 text-xs">
            <div className="text-red mb-2">{liqErr}</div>
            <button onClick={loadLiquidity} className="btn-ghost text-xs">Retry</button>
          </div>
        )}

        {liq && (
          <>
            <div className="grid gap-2.5 mb-2.5"
                 style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
              <Metric label="Deployable inside 20 sessions"
                      value={money(plan.deployable)}
                      tone={plan.deployable >= notional * 0.8 ? "text-green" : "text-amber"}
                      sub={`of ${money(notional)} intended`} />
              <Metric label="Blocked by liquidity"
                      value={money(plan.blocked)}
                      tone={plan.blocked > 0 ? "text-red" : "text-green"}
                      sub="legs needing over a month, or unquotable" />
              <Metric label="Slowest leg"
                      value={plan.worstDays == null ? "—" : `${fmtNum(plan.worstDays, 1)}d`}
                      tone={VERDICT_TONE[plan.rows[0]?.verdict ?? "unknown"]}
                      sub="sets the timeline for the whole idea" />
              <Metric label="Names priced"
                      value={`${liq.summary.priced}/${liq.summary.names}`}
                      sub={liq.summary.unknown
                        ? `${liq.summary.unknown} had no usable volume history`
                        : "all counterparties had volume history"} />
            </div>

            <ScrollX className="panel">
              <table className="w-full text-[11.5px]">
                <thead className="text-mut uppercase tracking-wider">
                  <tr className="border-b border-line2">
                    <th className="text-left px-2.5 py-2 font-medium">Counterparty</th>
                    <th className="text-left px-2.5 py-2 font-medium">Ticker</th>
                    <th className="text-right px-2.5 py-2 font-medium">Weight</th>
                    <th className="text-right px-2.5 py-2 font-medium">Leg size</th>
                    <th className="text-right px-2.5 py-2 font-medium">ADV</th>
                    <th className="text-right px-2.5 py-2 font-medium">Sessions</th>
                    <th className="text-left px-2.5 py-2 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r) => {
                    const l = liq.names[r.ticker!.toUpperCase()];
                    return (
                      <tr key={r.name} className="border-b border-line/60 hover:bg-panel">
                        <td className="px-2.5 py-1.5 text-txt">{r.name}</td>
                        <td className="px-2.5 py-1.5 num text-amber">{r.ticker}</td>
                        <td className="px-2.5 py-1.5 num text-right text-mut">
                          {fmtNum((r.notional / notional) * 100, 1)}%
                        </td>
                        <td className="px-2.5 py-1.5 num text-right">{money(r.notional)}</td>
                        <td className="px-2.5 py-1.5 num text-right text-mut">
                          {l?.basis_value == null ? "—" : humanNumber(l.basis_value, "$")}
                        </td>
                        <td className="px-2.5 py-1.5 num text-right">
                          {r.days == null ? <span className="text-mut">—</span> : fmtNum(r.days, 1)}
                        </td>
                        <td className={`px-2.5 py-1.5 ${VERDICT_TONE[r.verdict]}`}>
                          {r.verdict}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollX>

            <Note>
              <span className="block mt-2">{liq.note}</span>
            </Note>
          </>
        )}
      </section>

      <Methodology id="chainExposure" />
    </div>
  );
}
