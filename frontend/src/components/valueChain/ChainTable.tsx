"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Download, ShieldCheck } from "lucide-react";

import { ScrollX } from "@/components/ScrollX";
import { EmptyState, Note } from "@/components/ui";
import type { MergedEntity, Role } from "@/lib/valueChainGraph";
import {
  buildRows, groupRows, sortRows, toCSV, totals,
  type ChainRow, type GroupKey, type QuoteLike, type SortKey,
} from "@/lib/valueChainTable";
import { fmtNum, humanNumber } from "@/lib/utils";

/**
 * The table view of the value chain — SPLC's working surface.
 *
 * Bloomberg's Supply Chain Analysis defaults to a chart but the screen
 * people actually work in is the table: one row per counterparty, ranked by
 * exposure, with the share of revenue or cost it accounts for, what that is
 * worth, the basis for the figure and the date it is as of. A graph answers
 * "who is connected to whom"; this answers "which five of these matter, and
 * how much of that is a guess".
 *
 * The last part is where this goes further than the original. Bloomberg
 * prints a source label. Every row here states plainly whether the number
 * was estimated by a model or verified by a person, the header says how much
 * of the set is quantified at all, and the CSV export carries the same
 * warning — so a spreadsheet built from this screen cannot quietly launder
 * an estimate into a reported figure.
 */

type Col = {
  key: SortKey | null;
  label: string;
  align?: "right";
  title?: string;
  render: (r: ChainRow) => React.ReactNode;
};

const ROLE_TONE: Record<Role, string> = {
  supplier: "text-amber border-amber/40",
  customer: "text-green border-green/40",
  competitor: "text-mut border-line2",
};

function pct(v: number | null, dp = 1) {
  return v == null ? <span className="text-mut">—</span> : `${fmtNum(v, dp)}%`;
}

export function ChainTable({
  entities, subject, generatedAt, quotes, onPick, roleFilter,
}: {
  entities: MergedEntity[];
  subject: string;
  generatedAt?: string | null;
  quotes?: Record<string, QuoteLike | null>;
  /** Clicking a row re-centres the map on that company, as SPLC does. */
  onPick?: (row: ChainRow) => void;
  roleFilter: Role | "all";
}) {
  const [sort, setSort] = useState<SortKey>("valueUsd");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [group, setGroup] = useState<GroupKey>("none");

  const rows = useMemo(() => {
    const all = buildRows(entities, { quotes, generatedAt });
    // Filter on ROLES, not the primary role: a company that both supplies and
    // buys belongs under both tabs, and hiding it from one of them is the
    // kind of omission that makes a research tool untrustworthy.
    return roleFilter === "all" ? all : all.filter((r) => r.roles.includes(roleFilter));
  }, [entities, quotes, generatedAt, roleFilter]);

  const sorted = useMemo(() => sortRows(rows, sort, dir), [rows, sort, dir]);
  const grouped = useMemo(() => groupRows(sorted, group), [sorted, group]);
  const agg = useMemo(() => totals(rows), [rows]);

  const columns: Col[] = [
    {
      key: "name", label: "Name",
      render: (r) => (
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-txt" title={r.note || r.name}>{r.name}</span>
          {r.confidence === "verified" && (
            <ShieldCheck size={11} className="text-green shrink-0"
                         aria-label="Verified by an administrator" />
          )}
        </span>
      ),
    },
    {
      key: "ticker", label: "Ticker",
      render: (r) => r.ticker
        ? <span className="num text-amber">{r.ticker}</span>
        : <span className="text-mut">—</span>,
    },
    {
      key: "country", label: "Listing",
      title: "Inferred from the ticker suffix — this is where it TRADES, "
        + "which is usually but not always where the business is.",
      render: (r) => r.country ?? <span className="text-mut">—</span>,
    },
    {
      key: null, label: "Roles",
      render: (r) => (
        <span className="flex gap-1 flex-wrap">
          {r.roles.map((role) => (
            <span key={role}
                  className={`text-[9px] uppercase tracking-wider px-1 py-px rounded border ${ROLE_TONE[role]}`}>
              {role.slice(0, 4)}
            </span>
          ))}
        </span>
      ),
    },
    {
      key: "pctRevenue", label: "% of revenue", align: "right",
      title: `Share of ${subject}'s revenue this customer is estimated to account for`,
      render: (r) => pct(r.pctRevenue),
    },
    {
      key: "pctCOGS", label: "% of input cost", align: "right",
      title: `Share of ${subject}'s cost of goods this supplier is estimated to account for`,
      render: (r) => pct(r.pctCOGS),
    },
    {
      key: "valueUsd", label: "Est. value", align: "right",
      title: "Estimated annual value of the relationship, in USD",
      render: (r) => r.valueUsd == null
        ? <span className="text-mut">—</span>
        : humanNumber(r.valueUsd, "$"),
    },
    {
      key: "yoyPct", label: "YoY", align: "right",
      render: (r) => r.yoyPct == null
        ? <span className="text-mut">—</span>
        : <span className={r.yoyPct >= 0 ? "text-green" : "text-red"}>
            {r.yoyPct >= 0 ? "+" : ""}{fmtNum(r.yoyPct, 1)}%
          </span>,
    },
    {
      key: "changePct", label: "Day", align: "right",
      title: "Live day move, where the ticker resolves to a listing we can quote",
      render: (r) => r.changePct == null
        ? <span className="text-mut">—</span>
        : <span className={r.changePct >= 0 ? "text-green" : "text-red"}>
            {r.changePct >= 0 ? "+" : ""}{fmtNum(r.changePct, 2)}%
          </span>,
    },
    {
      key: "confidence", label: "Basis",
      title: "Where the figure came from. 'Estimated' means a language model "
        + "produced it and no one has checked it.",
      render: (r) => (
        <span className={r.confidence === "verified" ? "text-green" : "text-mut"}>
          {r.confidence}
        </span>
      ),
    },
    {
      key: null, label: "As of",
      render: (r) => <span className="text-mut num">{(r.asOf || "—").slice(0, 10)}</span>,
    },
  ];

  function toggleSort(k: SortKey | null) {
    if (!k) return;
    if (k === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(k); setDir(k === "name" || k === "ticker" || k === "country" ? "asc" : "desc"); }
  }

  function exportCsv() {
    const blob = new Blob([toCSV(sorted, subject, generatedAt)],
                          { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `value-chain-${subject.replace(/[^A-Za-z0-9]+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!rows.length) {
    return (
      <EmptyState
        title={`No ${roleFilter === "all" ? "relationships" : `${roleFilter}s`} in this map.`}
        detail="The generated map carried none for this role. Regenerate, or
                switch tab — a company can have customers mapped and no
                suppliers." />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-2 text-[11px]">
        <span className="text-mut">
          <span className="num text-txt">{agg.n}</span> counterparties ·{" "}
          <span className="num text-txt">{agg.quantified}</span> carry a number ·{" "}
          <span className={`num ${agg.verified ? "text-green" : "text-mut"}`}>
            {agg.verified}
          </span> verified
        </span>
        {agg.pctCOGS != null && (
          <span className="text-mut" title="Sum of the estimated input-cost shares on screen">
            Σ input cost <span className="num text-txt">{fmtNum(agg.pctCOGS, 1)}%</span>
          </span>
        )}
        {agg.pctRevenue != null && (
          <span className="text-mut" title="Sum of the estimated revenue shares on screen">
            Σ revenue <span className="num text-txt">{fmtNum(agg.pctRevenue, 1)}%</span>
          </span>
        )}
        {agg.valueUsd != null && (
          <span className="text-mut">
            Σ value <span className="num text-txt">{humanNumber(agg.valueUsd, "$")}</span>
          </span>
        )}

        <div className="flex-1" />

        <label className="flex items-center gap-1.5 text-mut">
          Group by
          <select value={group} onChange={(e) => setGroup(e.target.value as GroupKey)}
                  className="input-bare !py-0.5 !px-1.5 text-[11px] cursor-pointer">
            <option value="none">None</option>
            <option value="role">Role</option>
            <option value="country">Listing</option>
            <option value="confidence">Basis</option>
          </select>
        </label>
        <button onClick={exportCsv}
                className="btn-ghost !py-1 text-[11px] flex items-center gap-1.5"
                title="Download these rows as CSV, with the provenance warning in the header">
          <Download size={11} /> Export
        </button>
      </div>

      <ScrollX className="panel">
        <table className="w-full text-[11.5px]">
          <thead className="text-mut uppercase tracking-wider">
            <tr className="border-b border-line2">
              {columns.map((c) => (
                <th key={c.label} title={c.title}
                    onClick={() => toggleSort(c.key)}
                    className={`px-2.5 py-2 font-medium whitespace-nowrap
                                ${c.align === "right" ? "text-right" : "text-left"}
                                ${c.key ? "cursor-pointer hover:text-amber" : ""}`}>
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {c.key === sort && (dir === "asc"
                      ? <ArrowUp size={9} /> : <ArrowDown size={9} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {grouped.map(([label, list]) => (
            <tbody key={label || "all"}>
              {label && (
                <tr className="bg-panel2/60">
                  <td colSpan={columns.length}
                      className="px-2.5 py-1 label-xs border-y border-line2">
                    {label} · {list.length}
                  </td>
                </tr>
              )}
              {list.map((r) => (
                <tr key={`${label}-${r.key}`}
                    onClick={() => onPick?.(r)}
                    className={`border-b border-line/60 hover:bg-panel
                                ${onPick ? "cursor-pointer" : ""}`}
                    title={onPick ? `Re-centre the map on ${r.name}` : undefined}>
                  {columns.map((c) => (
                    <td key={c.label}
                        className={`px-2.5 py-1.5 num
                                    ${c.align === "right" ? "text-right" : ""}`}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </ScrollX>

      <Note>
        <span className="block mt-2">
          Percentages are the model&apos;s estimate of how much of {subject}&apos;s
          revenue or input cost each counterparty accounts for. They do not sum
          to 100% and are not meant to: the map covers the largest
          relationships it knows about, not the whole book. A blank cell means
          no figure was produced — never zero.
        </span>
      </Note>

    </div>
  );
}
