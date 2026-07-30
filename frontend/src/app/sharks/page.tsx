"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Shell } from "@/components/Shell";
import { Methodology } from "@/components/Methodology";
import { Note, PageHeader } from "@/components/ui";
import { StatusBadge } from "@/components/StatusBadge";
import { Pager, SortableTh, TableToolbar, useTableControls } from "@/components/tableControls";
import { api, type DealRow, type FlowRow, type InsiderRow } from "@/lib/api";
import {
  dealsNote, flowNote, insiderKind, insiderNote, labelFor, rankFlow, readFlow,
  summariseInsiders, type InsiderKind,
} from "@/lib/dealFlow";
import { fmtNum, humanNumber } from "@/lib/utils";

function DealTable({ rows, label, kind }: {
  rows: DealRow[] | null; label: string; kind: "bulk" | "block";
}) {
  const ctl = useTableControls(rows ?? [], 50);
  if (!rows) return <div className="text-mut text-xs">Loading {label}…</div>;
  if (rows.length === 0) {
    return (
      <div className="panel-2 p-4 text-mut text-sm">
        Could not load {label} right now (NSE may be blocking programmatic access,
        or there are no deals yet today).
      </div>
    );
  }
  const cols = Object.keys(rows[0]);
  return (
    <div>
      <TableToolbar ctl={ctl} placeholder="Filter by symbol / client…" />
      <div className="panel overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-mut uppercase tracking-wider sticky top-0 bg-panel">
            <tr className="border-b border-line">
              {cols.map((c) => (
                <SortableTh key={c} label={labelFor(c)} k={c} ctl={ctl}
                            align={typeof rows[0]?.[c] === "number" ? "right" : "left"} />
              ))}
            </tr>
          </thead>
          <tbody>
            {ctl.pageRows.map((r, i) => (
              <tr key={i} className="border-b border-line/60 hover:bg-panel">
                {cols.map((c) => {
                  const v = r[c];
                  const display = typeof v === "number"
                    ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
                    : (v ?? "—");
                  return <td key={c} className={`px-3 py-2 num whitespace-nowrap text-txt/90 ${typeof v === "number" ? "text-right" : ""}`}>{display}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager ctl={ctl} />
      {/* What the reader is looking at. Disclosure is a size threshold, and
          every row has a willing counterparty — neither is obvious. */}
      <div className="mt-2">
        <Note>{dealsNote(kind, rows.length)}</Note>
      </div>
      <Methodology id="dealFlow" className="mt-3" />
    </div>
  );
}

/** Per-stock flow intel: net buy/sell by bulk/block participants. */
function FlowTable() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ rows: FlowRow[]; from: string | null; to: string | null; note: string | null } | null>(null);

  useEffect(() => {
    setData(null);
    api.dealsAggregate("bulk", days).then(setData).catch(() => setData({ rows: [], from: null, to: null, note: "Failed to load." }));
  }, [days]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {[30, 90].map((d) => (
          <button key={d} onClick={() => setDays(d)} className={`btn ${days === d ? "btn-primary" : "btn-ghost"}`}>
            Trailing {d}d
          </button>
        ))}
        {data?.from && (
          <span className="text-[11px] text-mut">covering {data.from} → {data.to}</span>
        )}
      </div>
      {data?.from && data.from === data.to && (
        <div className="text-[10.5px] text-amber/90 mb-3">
          Only the latest available end-of-day file ({data.to}) is covered right
          now regardless of the trailing-window selected — NSE publishes
          bulk/block deals end-of-day and older archive days aren&apos;t always
          retrievable. The 30d/90d windows fill in as more days become available.
        </div>
      )}
      {!data && <div className="text-mut text-xs">Aggregating…</div>}
      {data && data.rows.length === 0 && (
        <div className="panel-2 p-4 text-mut text-sm">{data.note || "No data in the window."}</div>
      )}
      {data && data.rows.length > 0 && (() => {
        const ranked = rankFlow(data.rows);
        return (
        <>
        {/* The names where buying and selling did NOT cancel. A big net value
            on a name that nets to zero is a transfer, not a signal, and it
            would otherwise sit at the top of the table. */}
        {ranked.length > 0 && (
          <div className="mb-3">
            <div className="label-xs mb-2">Genuinely one-sided</div>
            <div className="grid gap-2.5"
                 style={{ gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" }}>
              {ranked.slice(0, 6).map((r) => (
                <div key={r.symbol} className="hud p-3">
                  <div className="flex items-baseline gap-2">
                    <Link href={`/terminal?t=${encodeURIComponent(`${r.symbol}.NS`)}`}
                          className="text-amber hover:underline text-[12px] flex-1 min-w-0 truncate">
                      {r.symbol}
                    </Link>
                    <span className={`num text-[12px] shrink-0 ${
                      (r.netSkewPct ?? 0) >= 0 ? "text-green" : "text-red"}`}>
                      {(r.netSkewPct ?? 0) >= 0 ? "+" : ""}{fmtNum(r.netSkewPct ?? 0, 0)}%
                    </span>
                  </div>
                  <div className="text-[10px] text-mut mt-0.5 num">
                    {r.participants ?? "?"} participant{r.participants === 1 ? "" : "s"}
                    {" · "}{r.deals} deal{r.deals === 1 ? "" : "s"}
                    {r.netValue != null && ` · ${humanNumber(r.netValue, "₹")}`}
                  </div>
                  <div className="text-[10px] text-mut leading-relaxed mt-1">{r.read}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="panel overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-mut uppercase tracking-wider">
              <tr className="border-b border-line">
                <th className="text-left px-3 py-2 font-medium">Symbol</th>
                <th className="text-right px-3 py-2 font-medium">Deals</th>
                <th className="text-right px-3 py-2 font-medium">Participants</th>
                <th className="text-right px-3 py-2 font-medium">Buy qty</th>
                <th className="text-right px-3 py-2 font-medium">Sell qty</th>
                <th className="text-right px-3 py-2 font-medium">Net qty</th>
                <th className="text-right px-3 py-2 font-medium">Net value</th>
                <th className="text-right px-3 py-2 font-medium"
                    title="Net as a share of gross activity — net quantity alone can't tell a lopsided week from noise">
                  Net skew
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const read = readFlow(r);
                return (
                <tr key={r.symbol} className="border-b border-line/60 hover:bg-panel"
                    title={read.read}>
                  <td className="px-3 py-2">
                    <Link href={`/terminal?t=${encodeURIComponent(`${r.symbol}.NS`)}`} className="text-amber hover:underline">
                      {r.symbol}
                    </Link>
                  </td>
                  <td className="px-3 py-2 num text-right">{r.deals}</td>
                  <td className="px-3 py-2 num text-right">{r.participants ?? "—"}</td>
                  <td className="px-3 py-2 num text-right">{fmtNum(r.buy_qty, 0)}</td>
                  <td className="px-3 py-2 num text-right">{fmtNum(r.sell_qty, 0)}</td>
                  <td className={`px-3 py-2 num text-right ${r.net_qty >= 0 ? "text-green" : "text-red"}`}>
                    {fmtNum(r.net_qty, 0)}
                  </td>
                  <td className={`px-3 py-2 num text-right ${(r.net_value ?? 0) >= 0 ? "text-green" : "text-red"}`}>
                    {r.net_value != null ? humanNumber(r.net_value, "₹") : "—"}
                  </td>
                  {/* Dimmed when the two sides nearly cancel: that row is a
                      transfer between holders, not accumulation. */}
                  <td className={`px-3 py-2 num text-right ${
                    read.netSkewPct == null ? "text-mut"
                      : Math.abs(read.netSkewPct) < 20 ? "text-mut/60"
                      : read.netSkewPct > 0 ? "text-green" : "text-red"}`}>
                    {read.netSkewPct == null ? "—" : `${fmtNum(read.netSkewPct, 0)}%`}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          <Note>{flowNote(data.rows, ranked, data.from, data.to)}</Note>
          {data.note && <div className="text-[10.5px] text-mut">{data.note}</div>}
        </div>
        <Methodology id="dealFlow" className="mt-3" />
        </>
        );
      })()}
    </div>
  );
}

/** An allotment is not a buy, and the colour must not suggest it is. */
const KIND_TONE: Record<InsiderKind, string> = {
  "open-market buy": "text-green",
  "open-market sell": "text-red",
  allotment: "text-mut",
  pledge: "text-mut",
  "gift or transfer": "text-mut",
  other: "text-mut",
};

function InsiderTable() {
  const [data, setData] = useState<{ rows: InsiderRow[]; note: string | null } | null>(null);

  useEffect(() => {
    api.insiderDeals().then(setData).catch(() => setData({ rows: [], note: "Failed to load." }));
  }, []);

  if (!data) return <div className="text-mut text-xs">Loading insider disclosures…</div>;
  if (data.rows.length === 0) {
    return <div className="panel-2 p-4 text-mut text-sm">{data.note || "No recent disclosures."}</div>;
  }
  const summary = summariseInsiders(data.rows);
  return (
    <div>
      {/* Allotments counted apart from buys. Folding an ESOP grant into the
          buy count manufactures conviction out of compensation. */}
      <div className="grid gap-2.5 mb-3"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <div className="hud p-3">
          <div className="label-xs">Open-market buys</div>
          <div className="num text-lg mt-0.5 text-green">{summary.buys}</div>
        </div>
        <div className="hud p-3">
          <div className="label-xs">Open-market sales</div>
          <div className="num text-lg mt-0.5 text-red">{summary.sells}</div>
        </div>
        <div className="hud p-3" title="Compensation being issued, not a decision to buy">
          <div className="label-xs">Allotments</div>
          <div className="num text-lg mt-0.5 text-mut">{summary.allotments}</div>
        </div>
        <div className="hud p-3" title="Borrowing against stock — a balance-sheet fact, not a view">
          <div className="label-xs">Pledge-related</div>
          <div className="num text-lg mt-0.5 text-mut">{summary.pledges}</div>
        </div>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full text-xs" data-testid="insider-table">
          <thead className="text-mut uppercase tracking-wider">
            <tr className="border-b border-line">
              {["Symbol", "Person", "Category", "Type", "What it is", "Qty", "Value", "Date"].map((h) => (
                <th key={h} className={`px-3 py-2 font-medium whitespace-nowrap ${["Qty", "Value"].includes(h) ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => {
              const kind = insiderKind(r.type, (r as { mode?: string | null }).mode);
              return (
                <tr key={i} className="border-b border-line/60 hover:bg-panel">
                  <td className="px-3 py-2 text-amber">{r.symbol ?? "—"}</td>
                  <td className="px-3 py-2">{r.person ?? "—"}</td>
                  <td className="px-3 py-2 text-mut">{r.category ?? "—"}</td>
                  <td className="px-3 py-2">{r.type ?? "—"}</td>
                  <td className={`px-3 py-2 whitespace-nowrap ${KIND_TONE[kind]}`}>
                    {kind}
                  </td>
                  <td className="px-3 py-2 num text-right">{r.qty != null ? fmtNum(r.qty, 0) : "—"}</td>
                  <td className="px-3 py-2 num text-right">{r.value != null ? humanNumber(r.value, "₹") : "—"}</td>
                  <td className="px-3 py-2 text-mut whitespace-nowrap">{r.date ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2"><Note>{insiderNote(summary)}</Note></div>
      <Methodology id="dealFlow" className="mt-3" />
    </div>
  );
}

export default function SharksPage() {
  const [tab, setTab] = useState<"bulk" | "block" | "flow" | "insider">("flow");
  const [rows, setRows] = useState<DealRow[] | null>(null);

  useEffect(() => {
    if (tab !== "bulk" && tab !== "block") return;
    setRows(null);
    (tab === "bulk" ? api.bulkDeals() : api.blockDeals())
      .then(setRows)
      .catch(() => setRows([]));
  }, [tab]);

  return (
    <Shell>
      <PageHeader
        title="BIG SHARK UPDATES"
        actions={<StatusBadge kind="eod" />}
        subtitle={<>A true real-time feed of bulk/block deals requires a paid
          data subscription. NSE publishes these end-of-day only, so this is
          the latest <strong className="text-txt">end-of-day</strong> activity
          (best-effort from NSE archives), not a live tick feed.</>} />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={() => setTab("flow")} className={`btn ${tab === "flow" ? "btn-primary" : "btn-ghost"}`}>Flow intel</button>
        <button onClick={() => setTab("bulk")} className={`btn ${tab === "bulk" ? "btn-primary" : "btn-ghost"}`}>Bulk deals</button>
        <button onClick={() => setTab("block")} className={`btn ${tab === "block" ? "btn-primary" : "btn-ghost"}`}>Block deals</button>
        <button onClick={() => setTab("insider")} className={`btn ${tab === "insider" ? "btn-primary" : "btn-ghost"}`}>Insider (PIT)</button>
      </div>
      {tab === "flow" && <FlowTable />}
      {tab === "insider" && <InsiderTable />}
      {(tab === "bulk" || tab === "block") && (
        <DealTable rows={rows} kind={tab === "bulk" ? "bulk" : "block"}
                   label={tab === "bulk" ? "bulk deals" : "block deals"} />
      )}
    </Shell>
  );
}
