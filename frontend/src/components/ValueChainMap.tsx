"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, Download, ExternalLink, Flag, Maximize2, Pause, Pin, PinOff, Play, X,
} from "lucide-react";

import { ContagionPathFinder } from "@/components/ContagionPath";
import { DataAge } from "@/components/DataAge";
import { Markdown } from "@/components/Markdown";
import { Methodology } from "@/components/Methodology";
import { ChainTable } from "@/components/valueChain/ChainTable";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { StatusBadge } from "@/components/StatusBadge";
import {
  api, ApiError, type ChainNode, type Quote, type ValueChain,
  type VcHistoryEntry,
  type VcReportCount,
} from "@/lib/api";
import {
  clamp, CX, CY, DEFAULT_VIEW, EDGE_METRIC_LABEL, edgeOpacityFor, edgeWidthFor,
  diffChains, fitView, fmtUsd, fragilityScore, H, lookupReportCount, MAX_W, maxUsd,
  EMPTY_METRICS, mergeEntities, MIN_W, resolveMetric, W, zoomAt,
  type ChainDiff,
  type EdgeMetric, type MergedEntity, type Role, type View,
} from "@/lib/valueChainGraph";
import {
  buildEvidenceIndex, buildOverlayIndex, overlayFor,
  type EdgeEvidence, type NodeOverlay,
} from "@/lib/valueChainOverlays";
import { fmtNum, fmtPct, humanNumber } from "@/lib/utils";

/**
 * Bloomberg SPLC-style supply-chain node graph, rendered as an SVG.
 *   suppliers ──▶ [COMPANY] ──▶ customers
 *                    │
 *               competitors
 *
 * Honesty note: this map is AI-GENERATED (Groq/Gemini), not computed from
 * filings or procurement data. The UI labels it as such, shows when it was
 * generated, weights edges by the AI's exposure estimates, and every node
 * drills down: candidates resolve to real tickers (market-biased), the graph
 * can re-center recursively with a breadcrumb trail, maps can be pinned and
 * exported, and wrong relationships can be reported to a review queue.
 */
// Canvas geometry + view maths live in @/lib/valueChainGraph (unit-tested).
const COL = {
  company: "#ffb000",
  supplier: "#3b82f6",
  customer: "#22c55e",
  competitor: "#a78bfa",
};


type Selected = MergedEntity & { role: Role };
type Cand = { symbol: string; name: string; source: string };

/** Report reasons — mirrors REPORT_CATEGORIES in backend/routes/value_chain.py. */
const REPORT_CATEGORIES = [
  { value: "wrong_entity", label: "Wrong entity" },
  { value: "wrong_weight", label: "Wrong weight / percentage" },
  { value: "outdated", label: "Outdated relationship" },
  { value: "duplicate", label: "Duplicate node" },
  { value: "other", label: "Other" },
] as const;

/** Pointer travel (px) past which a press counts as a pan, not a node click. */
const DRAG_SLOP = 4;

type Placed = MergedEntity & { x: number; y: number };

// ── ticker resolution (market-biased, cached per node) ─────────────────────
const _resolveCache = new Map<string, Cand[]>();

function marketSuffix(t: string): string {
  const i = t.lastIndexOf(".");
  return i > 0 ? t.slice(i + 1).toUpperCase() : "";
}

/** Same-market candidates rank first; obviously wrong-market collisions
 *  (IOC.JO, IOC.DU when the parent is .NS) drop behind an expander. */
function splitByMarket(cands: Cand[], parentTicker: string): { primary: Cand[]; other: Cand[] } {
  const suf = marketSuffix(parentTicker);
  const local = (sym: string) => {
    const s = marketSuffix(sym);
    if (suf === "NS" || suf === "BO") return s === "NS" || s === "BO";
    if (suf === "") return s === "";
    return s === suf;
  };
  const primary: Cand[] = [];
  const other: Cand[] = [];
  for (const c of cands) {
    // The AI's own hint always stays visible — it may legitimately be
    // cross-market (e.g. 2222.SR supplier of a US company).
    (c.source === "AI-suggested" || local(c.symbol) ? primary : other).push(c);
  }
  return { primary, other };
}

async function resolveNode(node: { name: string; ticker?: string | null }): Promise<Cand[]> {
  const key = `${node.name}|${node.ticker ?? ""}`;
  const hit = _resolveCache.get(key);
  if (hit) return hit;
  const out: Cand[] = [];
  if (node.ticker) out.push({ symbol: node.ticker.toUpperCase(), name: node.name, source: "AI-suggested" });
  try {
    const hits = await api.search(node.name);
    for (const h of (hits ?? []).slice(0, 5)) {
      if (!out.some((c) => c.symbol === h.symbol.toUpperCase())) {
        out.push({ symbol: h.symbol.toUpperCase(), name: h.name, source: "search match" });
      }
    }
  } catch { /* search down — AI hint (if any) still shown */ }
  _resolveCache.set(key, out);
  return out;
}

// ── exports ─────────────────────────────────────────────────────────────────
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCsv(data: ValueChain) {
  const esc = (s: unknown) => {
    const v = s == null ? "" : String(s);
    return /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  // confidence column: "estimated" (AI) vs "verified" (admin-published) —
  // provenance is part of the data model, exported distinctly.
  // `roles` lists EVERY role the entity plays (so a customer+competitor is
  // identifiable in the export); one row per role occurrence is kept for
  // back-compat with anything already parsing this file.
  const lines = ["role,roles,name,note,revenue_pct,pct_revenue,pct_cogs,"
                 + "est_usd_value,yoy_pct,ticker_hint,confidence,verified_at"];
  const push = (role: Role, ns?: ChainNode[]) =>
    (ns ?? []).forEach((n) => lines.push(
      [role, esc((n.roles ?? [role]).join("|")), esc(n.name), esc(n.note),
       n.revenue_pct ?? "", n.pct_revenue ?? "", n.pct_cogs ?? "",
       n.est_usd_value ?? "", n.yoy_pct ?? "", esc(n.ticker),
       n.confidence ?? "estimated", esc(n.verified_at ?? "")].join(","),
    ));
  push("supplier", data.suppliers);
  push("customer", data.customers);
  push("competitor", data.competitors);
  download(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }),
    `value-chain_${data.ticker}.csv`);
}

function svgMarkup(el: SVGSVGElement): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("style", "background:#0c0e12");
  return new XMLSerializer().serializeToString(clone);
}

function exportSvg(el: SVGSVGElement, ticker: string) {
  download(new Blob([svgMarkup(el)], { type: "image/svg+xml" }), `value-chain_${ticker}.svg`);
}

function exportPng(el: SVGSVGElement, ticker: string) {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgMarkup(el)], { type: "image/svg+xml" }));
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = W * 2; canvas.height = H * 2;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#0c0e12";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => { if (b) download(b, `value-chain_${ticker}.png`); }, "image/png");
    }
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// ── pinning (saved snapshots that don't change when the AI regenerates) ─────
const PIN_PREFIX = "mb_vc_pin:";

function loadPin(ticker: string): { data: ValueChain; pinnedAt: number } | null {
  try {
    const raw = localStorage.getItem(PIN_PREFIX + ticker.toUpperCase());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePin(ticker: string, data: ValueChain) {
  try {
    localStorage.setItem(PIN_PREFIX + ticker.toUpperCase(),
      JSON.stringify({ data, pinnedAt: Date.now() }));
  } catch { /* quota */ }
}
function clearPin(ticker: string) {
  try { localStorage.removeItem(PIN_PREFIX + ticker.toUpperCase()); } catch { /* noop */ }
}

/** Small YoY trend arrow at an edge's midpoint. Only drawn where the model
 *  actually supplied a YoY estimate — absence means "unknown", not "flat". */
function YoyMark({ x, y, yoy }: { x: number; y: number; yoy: number | null }) {
  if (yoy == null || !Number.isFinite(yoy)) return null;
  const up = yoy >= 0;
  const col = up ? "#1fd286" : "#ff4d4f";
  return (
    <g aria-hidden="true">
      <title>{`YoY ${up ? "+" : ""}${fmtNum(yoy, 1)}% (AI est.)`}</title>
      <circle cx={x} cy={y} r={7.5} fill="#0c0e12" stroke={col} strokeWidth={1} opacity={0.95} />
      <path d={up ? `M${x - 3.4},${y + 2.2} L${x},${y - 2.8} L${x + 3.4},${y + 2.2} Z`
                  : `M${x - 3.4},${y - 2.2} L${x},${y + 2.8} L${x + 3.4},${y - 2.2} Z`}
            fill={col} />
    </g>
  );
}

// ── node box ────────────────────────────────────────────────────────────────
function Node({ x, y, label, note, pct, color, onClick, selected, verified, dimmed,
                onHover, onLeave, roles = [], disputed = 0, diffStatus, overlay,
                sourced = 0 }: {
  x: number; y: number; label: string; note?: string; pct?: number | null;
  color: string; onClick: () => void; selected: boolean;
  verified?: boolean; dimmed?: boolean; roles?: Role[]; disputed?: number;
  diffStatus?: "added" | "removed" | "changed" | "same";
  overlay?: NodeOverlay; sourced?: number;
  onHover?: (e: React.MouseEvent | React.FocusEvent) => void;
  onLeave?: () => void;
}) {
  const sub = pct != null ? `≈${fmtNum(pct, 0)}% · ${note ?? ""}` : note;
  const shown = (verified ? "✓ " : "") + label;
  // aria-label rather than <title>: <title> makes the browser render its own
  // slow native tooltip on top of ours, but we still owe screen readers an
  // accessible name.
  const a11y = `${verified ? "Verified" : "AI-estimated"}: ${label}${sub ? ` — ${sub}` : ""}`;
  return (
    <g onClick={onClick} style={{ cursor: "pointer" }} opacity={dimmed ? 0.15 : 1}
       role="button" tabIndex={0} aria-label={a11y}
       onMouseEnter={onHover} onMouseMove={onHover} onMouseLeave={onLeave}
       onFocus={onHover} onBlur={onLeave}
       onKeyDown={(e) => {
         if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
       }}>
      {/* Diff halo: added = green, removed = red, changed = amber. */}
      {diffStatus && diffStatus !== "same" && (
        <rect x={x - 83} y={y - 21} width={166} height={42} rx={7}
              fill="none" strokeWidth={2}
              stroke={diffStatus === "added" ? "#1fd286"
                    : diffStatus === "removed" ? "#ff4d4f" : "#ffb000"}
              strokeDasharray={diffStatus === "removed" ? "4 3" : undefined} />
      )}
      <rect x={x - 78} y={y - 16} width={156} height={32} rx={5}
            fill={selected ? "#1c2129" : "#11151b"} stroke={verified ? "#1fd286" : color}
            strokeWidth={selected ? 2.4 : verified ? 2 : 1.4} />
      <text x={x} y={y - 1} textAnchor="middle" fontSize={12}
            fill="#e8ecf2" fontWeight={600} fontFamily="JetBrains Mono, monospace">
        {shown.length > 20 ? shown.slice(0, 19) + "…" : shown}
      </text>
      {sub && (
        <text x={x} y={y + 11} textAnchor="middle" fontSize={8.5}
              fill="#7d8694" fontFamily="JetBrains Mono, monospace">
          {sub.length > 26 ? sub.slice(0, 25) + "…" : sub}
        </text>
      )}
      {/* Role badges — one dot per role this company plays. A single-role
          node gets none (the column already says it); a merged entity shows
          e.g. green+violet for "customer AND competitor". */}
      {roles.length > 1 && roles.map((r, i) => (
        <circle key={r} cx={x + 70 - i * 9} cy={y - 11} r={3.2}
                fill={COL[r]} stroke="#0c0e12" strokeWidth={0.8}>
          <title>{r}</title>
        </circle>
      ))}
      {/* Sourced: a headline names this counterparty alongside the subject,
          so the edge has a paper trail rather than only the model's word. */}
      {sourced > 0 && (
        <g>
          <title>{`${sourced} headline(s) name this counterparty alongside the subject company`}</title>
          <circle cx={x - 78} cy={y - 11} r={6} fill="#0c0e12" stroke="#1fd286" strokeWidth={1.2} />
          <text x={x - 78} y={y - 8.4} textAnchor="middle" fontSize={7.5} fill="#1fd286"
                fontWeight={700} fontFamily="JetBrains Mono, monospace">⚓</text>
        </g>
      )}

      {/* ── cross-module overlays ── */}
      {/* Holding: an amber ring around the whole box — you own this. */}
      {overlay?.held && (
        <g>
          <title>{`In your portfolio: ${overlay.held.qty} @ ${overlay.held.ticker}`}</title>
          <rect x={x - 82} y={y - 20} width={164} height={40} rx={7}
                fill="none" stroke="#ffb000" strokeWidth={1.6} opacity={0.85} />
          <circle cx={x + 78} cy={y - 18} r={6} fill="#0c0e12" stroke="#ffb000" strokeWidth={1.2} />
          <text x={x + 78} y={y - 15.4} textAnchor="middle" fontSize={8} fill="#ffb000"
                fontWeight={700} fontFamily="JetBrains Mono, monospace">₽</text>
        </g>
      )}
      {/* Big Sharks: a buy/sell triangle when a bulk/block/insider deal hit. */}
      {overlay && overlay.deals.length > 0 && (() => {
        const d = overlay.deals[0];
        const col = d.side === "buy" ? "#1fd286" : d.side === "sell" ? "#ff4d4f" : "#7d8694";
        return (
          <g>
            <title>{`${d.kind} ${d.side !== "unknown" ? d.side : "deal"} — ${d.label}${d.date ? ` (${d.date})` : ""}`}</title>
            <circle cx={x - 78} cy={y + 15} r={6.5} fill="#0c0e12" stroke={col} strokeWidth={1.2} />
            <path d={d.side === "sell"
                     ? `M${x - 81.4},${y + 12.8} L${x - 78},${y + 17.8} L${x - 74.6},${y + 12.8} Z`
                     : `M${x - 81.4},${y + 17.2} L${x - 78},${y + 12.2} L${x - 74.6},${y + 17.2} Z`}
                  fill={col} />
          </g>
        );
      })()}
      {/* News: a dot that PULSES when a matching headline just landed. */}
      {overlay && overlay.news.length > 0 && (
        <g className={overlay.fresh ? "vc-pulse" : undefined}>
          <title>{`${overlay.news.length} recent headline(s): ${overlay.news[0].title}`}</title>
          <circle cx={x + 78} cy={y + 15} r={6.5} fill="#0c0e12"
                  stroke={overlay.fresh ? "#ffb000" : "#4b5563"} strokeWidth={1.2} />
          <circle cx={x + 78} cy={y + 15} r={2.6} fill={overlay.fresh ? "#ffb000" : "#7d8694"} />
        </g>
      )}

      {/* Disputed badge — only once MORE THAN ONE person has flagged this
          relationship. A single flag is one opinion; repeats are a signal. */}
      {disputed > 1 && (
        <g>
          <title>{`Flagged as wrong by ${disputed} reports`}</title>
          <circle cx={x - 70} cy={y - 11} r={6} fill="#0c0e12" stroke="#ff4d4f" strokeWidth={1.2} />
          <text x={x - 70} y={y - 8.4} textAnchor="middle" fontSize={7.5} fill="#ff4d4f"
                fontWeight={700} fontFamily="JetBrains Mono, monospace">
            {disputed > 9 ? "9+" : disputed}
          </text>
        </g>
      )}
    </g>
  );
}

// ── drill-down panel ────────────────────────────────────────────────────────
function NodeDetail({ node, parentTicker, chainTicker, onClose, onRecenter, onReported,
                      overlay, evidence, chain }: {
  node: Selected; parentTicker: string; chainTicker: string;
  onClose: () => void; onRecenter: (symbol: string, name: string) => void;
  onReported?: () => void; overlay?: NodeOverlay; evidence?: EdgeEvidence[];
  chain?: ValueChain | null;
}) {
  const router = useRouter();
  const [cands, setCands] = useState<Cand[] | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [reported, setReported] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // Scenario simulator: shock THIS node and cascade it through the chain.
  const [shock, setShock] = useState(-20);
  const [scenario, setScenario] = useState<string | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [simErr, setSimErr] = useState<string | null>(null);
  const [reportCat, setReportCat] = useState<string>("wrong_entity");
  const [reportText, setReportText] = useState("");

  useEffect(() => {
    let alive = true;
    setCands(null); setQuote(null); setShowOther(false); setReported(false);
    setReportOpen(false); setReportCat("wrong_entity"); setReportText("");
    setScenario(null); setSimErr(null); setShock(-20);
    resolveNode(node).then((cs) => { if (alive) setCands(cs); });
    return () => { alive = false; };
  }, [node]);

  const split = cands ? splitByMarket(cands, parentTicker) : null;
  const best = split?.primary[0]?.symbol ?? split?.other[0]?.symbol;

  useEffect(() => {
    if (!best) return;
    let alive = true;
    api.quote(best).then((q) => { if (alive) setQuote(q); }).catch(() => { if (alive) setQuote(null); });
    return () => { alive = false; };
  }, [best]);

  const [watchState, setWatchState] = useState<"idle" | "saving" | "saved">("idle");
  const [headlines, setHeadlines] = useState<{ title: string; link: string }[]>([]);

  useEffect(() => {
    if (!best) { setHeadlines([]); return; }
    let alive = true;
    api.news(best, 3).then((n) => { if (alive) setHeadlines((n ?? []).slice(0, 3)); }).catch(() => {});
    return () => { alive = false; };
  }, [best]);

  async function watchCounterparty() {
    if (!best) return;
    setWatchState("saving");
    try {
      // Value-chain counterparty alert: fires on any >=5% intraday move.
      await api.createAlert({ kind: "move", ticker: best, op: ">", value: 5 });
      setWatchState("saved");
    } catch { setWatchState("idle"); }
  }

  async function flag() {
    setReporting(true);
    try {
      // Address the report at the ORIGINAL per-role node the backend stored
      // (a merged entity may display a longer name than the array entry).
      const src = node.sources[node.role] ?? node.sources[node.primaryRole];
      await api.reportValueChain(chainTicker, {
        node_name: src?.name ?? node.name, role: node.role ?? node.primaryRole,
        category: reportCat, reason: reportText.trim(),
      });
      setReported(true);
      setReportOpen(false);
      onReported?.();
    } catch { /* leave button re-tryable */ } finally {
      setReporting(false);
    }
  }

  const CandBtns = ({ list }: { list: Cand[] }) => (
    <>
      {list.map((c) => (
        <span key={c.symbol} className="inline-flex items-center gap-0.5">
          <button onClick={() => router.push(`/terminal?t=${encodeURIComponent(c.symbol)}`)}
                  title={`${c.name} (${c.source}) — open in terminal`}
                  className="btn-ghost flex items-center gap-1.5 text-xs whitespace-nowrap">
            <ExternalLink size={11} />
            {c.symbol}
            <span className="text-mut normal-case">· {c.source}</span>
          </button>
          <button onClick={() => onRecenter(c.symbol, c.name)}
                  title={`Re-center the value-chain map on ${c.symbol}`}
                  className="btn-ghost text-xs px-1.5" >
            ⌖
          </button>
        </span>
      ))}
    </>
  );

  // Vertical layout: this panel is docked in a ~340px column beside the
  // graph, not stretched across the page bottom.
  return (
    <div className="panel-2 p-3 flex flex-col gap-2 h-full overflow-y-auto">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0" style={{ color: COL[node.primaryRole] }}>●</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold break-words">{node.name}</div>
          {/* Every role this company plays — a merged entity lists them all. */}
          <div className="flex flex-wrap items-center gap-1 mt-0.5">
            {node.roles.map((r) => (
              <span key={r} className="text-[9px] uppercase tracking-wider rounded px-1 border"
                    style={{ color: COL[r], borderColor: `${COL[r]}80` }}>{r}</span>
            ))}
          </div>
        </div>
        <button onClick={onClose} title="Close panel"
                className="text-mut hover:text-txt shrink-0"><X size={14} /></button>
      </div>

      {/* Exposure is stated PER ROLE — the supplier number is a share of
          input costs, the customer number a share of revenue. Never blended. */}
      {node.roles.map((r) => {
        const m = node.metricsByRole[r];
        if (!m || (m.pctRevenue == null && m.pctCOGS == null
                   && m.estUSDValue == null && m.yoyPct == null)) return null;
        return (
          <div key={r} className="flex flex-col gap-0.5">
            {node.roles.length > 1 && (
              <span className="text-[9px] uppercase tracking-wider" style={{ color: COL[r] }}>{r}</span>
            )}
            {m.pctRevenue != null && <div className="text-[11px] text-amber">≈{fmtNum(m.pctRevenue, 1)}% of revenue <span className="text-mut">(AI est.)</span></div>}
            {m.pctCOGS != null && <div className="text-[11px] text-amber">≈{fmtNum(m.pctCOGS, 1)}% of input costs <span className="text-mut">(AI est.)</span></div>}
            {m.estUSDValue != null && <div className="text-[11px] text-amber">≈{fmtUsd(m.estUSDValue)}/yr <span className="text-mut">(AI est.)</span></div>}
            {m.yoyPct != null && (
              <div className={`text-[11px] ${m.yoyPct >= 0 ? "text-green" : "text-red"}`}>
                {m.yoyPct >= 0 ? "▲" : "▼"} {fmtNum(Math.abs(m.yoyPct), 1)}% YoY <span className="text-mut">(AI est.)</span>
              </div>
            )}
          </div>
        );
      })}
      {/* Per-role notes, so a customer note and a competitor note both show. */}
      {node.roles.map((r) => node.notesByRole[r] && (
        <div key={r} className="text-xs text-mut break-words">
          {node.roles.length > 1 && <span className="uppercase text-[9px] mr-1" style={{ color: COL[r] }}>{r}</span>}
          {node.notesByRole[r]}
        </div>
      ))}

      {quote && quote.price != null && best && (
        <div className="text-xs">
          <span className="text-mut">{best}</span>{" "}
          <span className="num">{fmtNum(quote.price, 2)}</span>{" "}
          {quote.change_pct != null && (
            <span className={`num ${quote.change_pct >= 0 ? "text-green" : "text-red"}`}>{fmtPct(quote.change_pct)}</span>
          )}
        </div>
      )}

      {overlay && overlay.news.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="label-xs">Headlines naming {node.name}</span>
          {overlay.news.map((n, i) => (
            <a key={i} href={n.link} target="_blank" rel="noopener noreferrer"
               className="block text-[11px] text-mut hover:text-amber line-clamp-2">› {n.title}</a>
          ))}
        </div>
      )}
      {headlines.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {headlines.map((h, i) => (
            <a key={i} href={h.link} target="_blank" rel="noopener noreferrer"
               className="block text-[11px] text-mut hover:text-amber line-clamp-2">› {h.title}</a>
          ))}
        </div>
      )}

      {/* Evidence: headlines naming BOTH companies. This is CO-MENTION
          sourcing — it proves they were written about together, not that the
          specific supplier/customer claim is correct. Said plainly. */}
      {evidence && evidence.length > 0 && (
        <div className="rounded border border-green/40 bg-green/5 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-green mb-1">
            ⚓ {evidence.length} source{evidence.length > 1 ? "s" : ""} co-mention this relationship
          </div>
          {evidence.map((e, i) => (
            <a key={i} href={e.link} target="_blank" rel="noopener noreferrer"
               className="block text-[11px] text-mut hover:text-amber line-clamp-2 mb-0.5">
              › {e.title}
              {e.published && (
                <span className="text-mut/70"> · {new Date(e.published).toLocaleDateString()}</span>
              )}
            </a>
          ))}
          <div className="text-[9.5px] text-mut/70 mt-1">
            Co-mention only: these name both companies together — they don&apos;t
            confirm the specific supplier/customer claim.
          </div>
        </div>
      )}

      {/* Cross-module signals for this counterparty. */}
      {overlay?.held && (
        <div className="rounded border border-amber/50 bg-amber/10 px-2 py-1 text-[11px]">
          <span className="text-amber">◎ In your portfolio</span>{" "}
          <span className="text-mut">{fmtNum(overlay.held.qty, 0)} {overlay.held.ticker}</span>
          {overlay.held.pnlPct != null && (
            <span className={overlay.held.pnlPct >= 0 ? "text-green" : "text-red"}> {fmtPct(overlay.held.pnlPct)}</span>
          )}
        </div>
      )}
      {overlay && overlay.deals.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="label-xs">Recent shark activity</span>
          {overlay.deals.map((d, i) => (
            <div key={i} className={`text-[11px] ${d.side === "sell" ? "text-red" : d.side === "buy" ? "text-green" : "text-mut"}`}>
              {d.side === "sell" ? "▼" : d.side === "buy" ? "▲" : "•"} {d.kind} — {d.label}
              {d.value != null && <span className="text-mut"> {humanNumber(d.value)}</span>}
              {d.date && <span className="text-mut"> · {d.date}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {/* Immediate skeleton — no more staring at stale content while search runs. */}
        {cands === null && (
          <>
            <span className="inline-block h-6 w-28 rounded bg-panel animate-pulse" />
            <span className="inline-block h-6 w-24 rounded bg-panel animate-pulse" />
          </>
        )}
        {split && split.primary.length === 0 && split.other.length === 0 && (
          <span className="text-[11px] text-mut">No listed ticker found — likely private or a segment.</span>
        )}
        {split && <CandBtns list={split.primary} />}
        {split && split.other.length > 0 && !showOther && (
          <button onClick={() => setShowOther(true)} className="text-[11px] text-mut hover:text-txt underline">
            {split.other.length} other market{split.other.length > 1 ? "s" : ""}…
          </button>
        )}
        {split && showOther && <CandBtns list={split.other} />}
      </div>

      {best && (
        <div className="flex flex-col gap-1">
          <button onClick={() => router.push(`/terminal?t=${encodeURIComponent(best)}&fn=SPLC`)}
                  className="btn-ghost text-[11px]" title="Open this counterparty's own value-chain map">
            Their value chain
          </button>
          <button onClick={watchCounterparty} disabled={watchState !== "idle"}
                  className={`btn-ghost text-[11px] ${watchState === "saved" ? "!text-green" : ""}`}
                  title="Create an alert: notify me when this counterparty moves >=5% in a day">
            {watchState === "saved" ? "Watching ✓" : watchState === "saving" ? "…" : "Watch ≥5% move"}
          </button>
        </div>
      )}

      {/* Scenario simulator — walks the CHAIN, not just the parent ticker. */}
      <div className="rounded border border-line2 px-2 py-1.5">
        <div className="label-xs mb-1">Scenario</div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-mut">If output</span>
          <select value={shock} onChange={(e) => setShock(parseFloat(e.target.value))}
                  className="input-bare !py-0.5 !px-1 text-[11px] cursor-pointer">
            {[-50, -30, -20, -10, 10, 20, 50].map((v) => (
              <option key={v} value={v}>{v > 0 ? `+${v}` : v}%</option>
            ))}
          </select>
          <button
            onClick={async () => {
              setSimBusy(true); setSimErr(null); setScenario(null);
              try {
                const r = await api.vcScenario({
                  ticker: chainTicker, company: chain?.name || chainTicker,
                  node_name: node.name, node_role: node.role ?? node.primaryRole,
                  shock_pct: shock,
                  context: {
                    suppliers: chain?.suppliers ?? [], customers: chain?.customers ?? [],
                    competitors: chain?.competitors ?? [],
                  },
                });
                setScenario(r.markdown);
              } catch (e: any) {
                setSimErr(e?.detail || "Scenario generation failed.");
              } finally { setSimBusy(false); }
            }}
            disabled={simBusy}
            className="btn-ghost text-[11px] disabled:opacity-50">
            {simBusy ? "Simulating…" : "Simulate"}
          </button>
        </div>
        {simErr && <div className="text-red text-[11px] mt-1">{simErr}</div>}
        {scenario && (
          <div className="mt-2 border-t border-line pt-2">
            <div className="mb-1"><StatusBadge kind="ai" /></div>
            <div className="max-h-64 overflow-y-auto"><Markdown>{scenario}</Markdown></div>
          </div>
        )}
      </div>

      <div className="mt-auto pt-1 relative">
        <button onClick={() => setReportOpen((v) => !v)} disabled={reported}
                aria-expanded={reportOpen} aria-haspopup="dialog"
                title="Flag this relationship as wrong — goes to the admin review queue"
                className={`flex items-center gap-1 text-[11px] ${reported ? "text-green" : "text-mut hover:text-red"}`}>
          <Flag size={12} />
          {reported ? "Reported ✓" : "Report"}
        </button>
        {reportOpen && !reported && (
          <div role="dialog" aria-label="Report this relationship"
               className="absolute bottom-full left-0 mb-2 w-[260px] z-30 panel-2 p-2.5
                          border border-line2 shadow-panel rounded">
            <div className="label-xs mb-1.5">What&apos;s wrong?</div>
            <div className="flex flex-col gap-1">
              {REPORT_CATEGORIES.map((c) => (
                <label key={c.value} className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                  <input type="radio" name="vc-report-cat" value={c.value}
                         checked={reportCat === c.value}
                         onChange={() => setReportCat(c.value)}
                         className="accent-amber" />
                  {c.label}
                </label>
              ))}
            </div>
            <textarea value={reportText} onChange={(e) => setReportText(e.target.value)}
                      rows={2} maxLength={500}
                      placeholder={reportCat === "other" ? "Tell us what's wrong (required)" : "Extra detail (optional)"}
                      className="input-bare w-full mt-2 text-[11px] resize-y" />
            <div className="flex items-center gap-2 mt-2">
              <button onClick={flag}
                      disabled={reporting || (reportCat === "other" && !reportText.trim())}
                      className="btn-primary text-[11px] disabled:opacity-50">
                {reporting ? "Sending…" : "Submit"}
              </button>
              <button onClick={() => setReportOpen(false)} className="btn-ghost text-[11px]">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── main component ──────────────────────────────────────────────────────────
export function ValueChainMap({ ticker }: { ticker: string }) {
  // Breadcrumb trail for recursive drill-down; last entry = shown company.
  const [trail, setTrail] = useState<{ t: string; name: string }[]>([]);
  const current = trail.length ? trail[trail.length - 1].t : ticker;

  const [data, setData] = useState<ValueChain | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [pinnedAt, setPinnedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errServerFault, setErrServerFault] = useState(false);
  // SPLC is two views of one dataset. The chart answers "who is connected to
  // whom"; the table answers "which five of these matter and how much of
  // that is a guess", which is the question research actually starts from.
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const [roleTab, setRoleTab] = useState<Role | "all">("all");
  const [nodeQuotes, setNodeQuotes] = useState<Record<string, Quote | null>>({});
  const [selected, setSelected] = useState<Selected | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // New seed ticker (from the terminal search) resets the trail.
  useEffect(() => { setTrail([]); }, [ticker]);

  // History snapshots + zoom/pan + in-graph filter (flagship upgrades).
  const [history, setHistory] = useState<VcHistoryEntry[]>([]);
  const [snapshotTs, setSnapshotTs] = useState<string | null>(null); // viewing a prior version
  // Aggregate flags per entity (normalised name -> count), for the disputed badge.
  const [reportCounts, setReportCounts] = useState<Record<string, VcReportCount>>({});
  // Cross-module overlays: what you hold, who's trading it, what just broke.
  const [positions, setPositions] = useState<{ ticker: string; qty: number; value?: number | null; pnl_pct?: number | null }[]>([]);
  const [deals, setDeals] = useState<{ bulk: any[]; block: any[]; insider: any[] }>({ bulk: [], block: [], insider: [] });
  const [newsItems, setNewsItems] = useState<{ title: string; link: string; published: string | null; publisher?: string }[]>([]);
  const [overlaysOn, setOverlaysOn] = useState(true);
  // Links already rendered — anything new pulses on arrival.
  const seenLinksRef = useRef<Set<string>>(new Set());
  const [pulseEpoch, setPulseEpoch] = useState(0);
  const [graphFilter, setGraphFilter] = useState("");
  // Which quantitative measure drives edge thickness/intensity.
  const [edgeMetric, setEdgeMetric] = useState<EdgeMetric>("pctRevenue");
  // "Compare to previous": diff the LIVE map against a chosen prior snapshot.
  const [compareTs, setCompareTs] = useState<string | null>(null);
  // Time-lapse: step through stored generations oldest → newest.
  const [playing, setPlaying] = useState(false);
  const [playIdx, setPlayIdx] = useState(0);
  const [view, setView] = useState<View>({ ...DEFAULT_VIEW });
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest view for the NATIVE wheel listener (which closes over its own scope).
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  // Active pointers, for two-finger pinch-zoom.
  const ptrsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; w: number } | null>(null);
  // Set once a press travels past DRAG_SLOP, so releasing a pan doesn't also
  // "click" whatever node the drag happened to start on.
  const draggedRef = useRef(false);

  // Hover tooltip: full untruncated text without needing a click. Position is
  // container-relative px; flip flags keep it inside the canvas near edges.
  const [hover, setHover] = useState<
    { node: MergedEntity; role: Role; cx: number; cy: number; flipX: boolean; flipY: boolean } | null
  >(null);

  const showTip = useCallback((e: React.MouseEvent | React.FocusEvent,
                               node: MergedEntity, role: Role) => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // FocusEvent has no coordinates — fall back to the focused node's own box.
    const src = "clientX" in e
      ? { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY }
      : (() => {
          const b = (e.target as Element).getBoundingClientRect?.();
          return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : { x: r.left, y: r.top };
        })();
    const cx = src.x - r.left, cy = src.y - r.top;
    setHover({ node, role, cx, cy, flipX: cx > r.width - 280, flipY: cy > r.height - 150 });
  }, []);
  const hideTip = useCallback(() => setHover(null), []);

  // Request-id guard: a slow generation for a previously-shown node must not
  // overwrite the map after the user re-centered or switched ticker.
  const loadReqRef = useRef(0);

  const load = useCallback((t: string, refresh = false) => {
    const reqId = ++loadReqRef.current;
    setBusy(true); setErr(null); setErrServerFault(false);
    setData(null); setSelected(null); setPinnedAt(null);
    setSnapshotTs(null); setCompareTs(null); setView({ ...DEFAULT_VIEW });
    setPlaying(false); setPlayIdx(0); framedRef.current = null;
    const pin = !refresh && loadPin(t);
    if (pin) {
      setData(pin.data); setFetchedAt(pin.pinnedAt); setPinnedAt(pin.pinnedAt); setBusy(false);
      return;
    }
    api.valueChain(t, refresh)
      .then((m) => { if (loadReqRef.current === reqId) { setData(m.data); setFetchedAt(m.fetchedAt); } })
      .catch((e) => {
        if (loadReqRef.current !== reqId) return;
        setErr(e?.detail || "Value-chain mapping failed.");
        setErrServerFault(e instanceof ApiError ? e.serverFault : false);
      })
      .finally(() => { if (loadReqRef.current === reqId) setBusy(false); });
    api.vcHistory(t)
      .then((h) => { if (loadReqRef.current === reqId) setHistory(h); })
      .catch(() => { if (loadReqRef.current === reqId) setHistory([]); });
    api.vcReportCounts(t)
      .then((r) => { if (loadReqRef.current === reqId) setReportCounts(r.counts ?? {}); })
      .catch(() => { if (loadReqRef.current === reqId) setReportCounts({}); });
  }, []);

  useEffect(() => { load(current); }, [current, load]);

  // ── overlay sources ─────────────────────────────────────────────────────
  // Portfolio + deals are slow-moving: fetched once per mapped company.
  useEffect(() => {
    let alive = true;
    api.portfolioSummary()
      .then((p) => { if (alive) setPositions(p.positions ?? []); })
      .catch(() => { if (alive) setPositions([]); });
    Promise.allSettled([api.bulkDeals(), api.blockDeals(), api.insiderDeals()])
      .then(([b, k, i]) => {
        if (!alive) return;
        setDeals({
          bulk: b.status === "fulfilled" ? (b.value as any[]) ?? [] : [],
          block: k.status === "fulfilled" ? (k.value as any[]) ?? [] : [],
          insider: i.status === "fulfilled" ? (i.value as any)?.rows ?? [] : [],
        });
      });
    return () => { alive = false; };
  }, []);

  // News is the live one: the subject's own feed plus the market tape, polled
  // while the tab is visible. New headlines make their node pulse.
  useEffect(() => {
    let alive = true;
    seenLinksRef.current = new Set();   // new company => nothing "seen" yet
    const pull = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const [t, m] = await Promise.allSettled([
        api.news(current, 20), api.marketNews(30),
      ]);
      if (!alive) return;
      const merged: Record<string, { title: string; link: string; published: string | null; publisher?: string }> = {};
      for (const r of [t, m]) {
        if (r.status !== "fulfilled") continue;
        for (const n of ((r.value as any[]) ?? [])) {
          if (n?.link) merged[n.link] = n;
        }
      }
      const items = Object.values(merged);
      setNewsItems(items);
      setPulseEpoch((n) => n + 1);
      // Let the pulse run for a few seconds, then mark these links seen so a
      // headline announces itself exactly once.
      setTimeout(() => {
        if (!alive) return;
        for (const n of items) seenLinksRef.current.add(n.link);
        setPulseEpoch((n) => n + 1);
      }, 6000);
    };
    pull();
    const id = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [current]);

  // ── time-lapse playback ─────────────────────────────────────────────────
  // History arrives newest-first; playback runs the other way so the chain
  // visibly evolves forwards.
  const chrono = useMemo(() => [...history].reverse(), [history]);

  useEffect(() => {
    if (!playing) return;
    if (chrono.length < 2) { setPlaying(false); return; }
    const id = setInterval(() => {
      setPlayIdx((i) => {
        if (i + 1 >= chrono.length) { setPlaying(false); return i; }
        return i + 1;
      });
    }, 1600);
    return () => clearInterval(id);
  }, [playing, chrono.length]);

  // Show whichever frame the scrubber/playhead is on.
  const framedRef = useRef<string | null>(null);
  useEffect(() => {
    const entry = chrono[playIdx];
    if (!entry?.data) return;
    // Only drive the view while scrubbing/playing, never on first mount.
    if (framedRef.current === null) { framedRef.current = "init"; return; }
    setData(entry.data);
    setSnapshotTs(entry.generated_at);
    setSelected(null);
  }, [playIdx, chrono]);

  function viewSnapshot(entry: VcHistoryEntry) {
    setData(entry.data); setSnapshotTs(entry.generated_at); setSelected(null);
  }

  // ── zoom: NATIVE non-passive wheel listener ────────────────────────────
  // React attaches wheel handlers passively at the root, so a synthetic
  // onWheel's preventDefault() is ignored and the PAGE scrolls while you try
  // to zoom. A native listener with {passive:false} is the only thing that
  // actually keeps the wheel inside the canvas. Zoom is anchored to the
  // cursor (the point under the pointer stays put) rather than the centre.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      setView(zoomAt(v, e.deltaY > 0 ? 1.15 : 1 / 1.15, fx, fy));
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
    // Re-attach when the canvas (re)mounts after a load.
  }, [data]);

  // ── pan (1 pointer) + pinch-zoom (2 pointers) ──────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    ptrsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    draggedRef.current = false;
    if (ptrsRef.current.size === 2) {
      const [a, b] = [...ptrsRef.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: view.w };
      panRef.current = null;
      return;
    }
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    // Text selection is killed by user-select:none on the container (see the
    // JSX), NOT by preventDefault() here — preventDefault on pointerdown
    // suppresses the compatibility mouse events, which would stop node
    // clicks from registering at all.
    // Capture on e.target (not the container): pointer capture retargets the
    // derived click event, so capturing on the container would break node
    // selection. Events from the captured node still bubble to this handler.
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (ptrsRef.current.has(e.pointerId)) {
      ptrsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // Pinch: viewBox width scales with the inverse of finger separation.
    const pinch = pinchRef.current;
    if (pinch && ptrsRef.current.size >= 2) {
      const [a, b] = [...ptrsRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0) {
        draggedRef.current = true;
        const w = clamp(pinch.w * (pinch.dist / dist), MIN_W, MAX_W);
        const h = w * (H / W);
        setView((v) => ({ x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h }));
      }
      return;
    }
    const p = panRef.current;
    if (!p || !containerRef.current) return;
    const dx = e.clientX - p.sx, dy = e.clientY - p.sy;
    if (!draggedRef.current && Math.hypot(dx, dy) > DRAG_SLOP) draggedRef.current = true;
    const scale = view.w / (containerRef.current.clientWidth || W);
    setView((v) => ({ ...v, x: p.vx - dx * scale, y: p.vy - dy * scale }));
  }

  function onPointerUp(e: React.PointerEvent) {
    ptrsRef.current.delete(e.pointerId);
    if (ptrsRef.current.size < 2) pinchRef.current = null;
    if (ptrsRef.current.size === 0) panRef.current = null;
  }

  const matchesFilter = (n: { name: string; note?: string }) => {
    const f = graphFilter.trim().toLowerCase();
    if (!f) return true;
    return n.name.toLowerCase().includes(f) || (n.note ?? "").toLowerCase().includes(f);
  };

  function recenter(symbol: string, name: string) {
    setTrail((tr) => [...tr, { t: symbol, name }]);
  }

  function togglePin() {
    if (!data) return;
    if (pinnedAt) { clearPin(current); load(current); return; }
    savePin(current, data);
    setPinnedAt(Date.now());
  }

  // Layout is computed ABOVE the early returns so the fit-to-view control and
  // the minimap (which need node coordinates) can be plain hooks.
  // De-duplicated model: one node per COMPANY (with all its roles), not one
  // per role occurrence. Columns are then filled by primary role.
  /** One row per COMPANY, with every role it plays — shared by both views. */
  const entities = useMemo(() => (data ? mergeEntities(data) : []), [data]);

  // Live quotes for counterparties the model gave a ticker for. Capped at the
  // endpoint's own limit; a value-chain map with 40 named tickers must not
  // turn into a 40-symbol market-data request.
  useEffect(() => {
    const tickers = Array.from(new Set(
      entities.map((e) => (e.ticker || "").trim().toUpperCase()).filter(Boolean),
    )).slice(0, 30);
    if (!tickers.length) { setNodeQuotes({}); return; }
    let alive = true;
    api.quoteBulk(tickers)
      .then((q) => { if (alive) setNodeQuotes(q); })
      .catch(() => { if (alive) setNodeQuotes({}); });
    return () => { alive = false; };
  }, [entities]);

  const layout = useMemo(() => {
    if (!data) return null;
    const merged = mergeEntities(data);

    // Biggest exposure at the top of each column. Reading order in a bowtie
    // is top-down, so an unsorted column buries the relationship that
    // matters behind whichever one the model happened to emit first.
    const byWeight = (a: MergedEntity, b: MergedEntity, role: Role) => {
      const av = resolveMetric(a.metricsByRole[role] ?? EMPTY_METRICS, edgeMetric).value;
      const bv = resolveMetric(b.metricsByRole[role] ?? EMPTY_METRICS, edgeMetric).value;
      if (av == null && bv == null) return a.name.localeCompare(b.name);
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    };

    // Caps raised from 10/12/8: Bloomberg's chart carries roughly twenty a
    // side, and truncating to ten silently dropped real counterparties. The
    // gap shrinks to fit rather than the list being cut.
    const supList = merged.filter((e) => e.primaryRole === "supplier")
      .sort((a, b) => byWeight(a, b, "supplier")).slice(0, 20);
    const cusList = merged.filter((e) => e.primaryRole === "customer")
      .sort((a, b) => byWeight(a, b, "customer")).slice(0, 20);
    const cmpList = merged.filter((e) => e.primaryRole === "competitor")
      .sort((a, b) => byWeight(a, b, "competitor")).slice(0, 10);
    const sGap = Math.min(70, (H - 120) / Math.max(supList.length, 1));
    const cGap = Math.min(70, (H - 120) / Math.max(cusList.length, 1));
    // Columns hug the edges, which is what gives the bowtie its shape: two
    // dense stacks of names with the subject alone in the middle.
    return {
      suppliers: supList.map((it, i): Placed => ({ ...it, x: 130, y: 60 + i * sGap })),
      customers: cusList.map((it, i): Placed => ({ ...it, x: W - 130, y: 60 + i * cGap })),
      competitors: cmpList.map((it, i, arr): Placed => ({
        ...it,
        x: CX + (i - (arr.length - 1) / 2) * Math.min(180, (W - 200) / Math.max(arr.length, 1)),
        y: H - 60,
      })),
    };
  }, [data, edgeMetric]);

  /** Frame every node — the escape hatch when a 30-node map runs off-canvas. */
  const fitToView = useCallback(() => {
    if (!layout) { setView({ ...DEFAULT_VIEW }); return; }
    setView(fitView([
      ...layout.suppliers, ...layout.customers, ...layout.competitors,
      { x: CX, y: CY },   // always keep the subject company in frame
    ]));
  }, [layout]);

  if (busy) return <PanelLoading label="Mapping value chain (AI)…" rows={5} />;
  if (err) {
    // The failure message names Regenerate as the recovery, so Regenerate
    // has to be ON SCREEN. It used to live only in the header that renders
    // when a map exists — telling the user to click a button that wasn't
    // there.
    return (
      <PanelError
        error={err}
        serverFault={errServerFault}
        retry={() => load(current)}
        action={
          <button onClick={() => load(current, true)}
                  className="btn-primary text-xs"
                  title="Discard the cached map and ask the model again">
            Regenerate
          </button>
        } />
    );
  }
  if (!data || !layout) return null;

  const { suppliers, customers, competitors } = layout;
  // One flat list — edges are keyed off each entity's ROLES, not the column
  // it happens to be drawn in.
  const allNodes: Placed[] = [...suppliers, ...customers, ...competitors];
  // Dollar edges are normalised against the biggest relationship in THIS
  // graph (percentages keep their own absolute 0-100 scale).
  const usdMax = maxUsd(allNodes.flatMap((n) =>
    n.roles.map((r) => n.metricsByRole[r]?.estUSDValue ?? null)));
  /** Resolve the drawing weight for one (entity, role) edge. */
  const edgeOf = (n: Placed, role: Role) =>
    resolveMetric(n.metricsByRole[role] ?? {
      pctRevenue: null, pctCOGS: null, estUSDValue: null, yoyPct: null,
    }, edgeMetric);
  // How many edges can't answer the selected metric — surfaced in the legend
  // rather than silently drawn as if they were simply small.
  const flowEdges = allNodes.flatMap((n) =>
    n.roles.filter((r) => r !== "competitor").map((r) => edgeOf(n, r)));
  const missingMetric = flowEdges.filter((e) => e.value == null || e.fellBack).length;

  // Diff against the selected baseline snapshot (null = compare mode off).
  const diff: ChainDiff | null = (() => {
    if (!compareTs || !data) return null;
    const baseEntry = history.find((h) => h.generated_at === compareTs);
    return baseEntry?.data ? diffChains(data, baseEntry.data, 5) : null;
  })();
  const DIFF_COL: Record<string, string> = {
    added: "#1fd286", removed: "#ff4d4f", changed: "#ffb000",
  };

  // Cross-module overlay index (holdings / deals / news) keyed by entity.
  const overlays = overlaysOn
    ? buildOverlayIndex(allNodes, {
        positions, bulk: deals.bulk, block: deals.block, insider: deals.insider,
        news: newsItems, seenLinks: seenLinksRef.current,
      })
    : new Map<string, NodeOverlay>();
  // Chain Fragility Score — the headline read on this chain's brittleness.
  const fragility = fragilityScore(allNodes);
  const FRAG_COL = fragility.band === "fragile" ? "#ff4d4f"
                 : fragility.band === "concentrated" ? "#ffb000"
                 : fragility.band === "moderate" ? "#c9a25a" : "#1fd286";
  // Co-mention evidence: headlines naming BOTH this company and the
  // counterparty are real, timestamped proof the relationship exists.
  const evidence = buildEvidenceIndex(data.name, allNodes, newsItems);
  const heldCount = [...overlays.values()].filter((o) => o.held).length;
  const dealCount = [...overlays.values()].filter((o) => o.deals.length).length;
  const newsCount = [...overlays.values()].filter((o) => o.news.length).length;

  const pick = (n: Placed) => {
    // A press that panned isn't a selection click.
    if (draggedRef.current) return;
    setSelected((cur) => (cur?.key === n.key ? null : { ...n, role: n.primaryRole }));
  };

  return (
    <div>
      {/* Breadcrumb trail for recursive drill-down */}
      {trail.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mb-2 text-xs">
          <button onClick={() => setTrail([])} className="text-amber hover:underline">{ticker}</button>
          {trail.map((b, i) => (
            <span key={`${b.t}${i}`} className="flex items-center gap-1">
              <ChevronRight size={11} className="text-mut" />
              {i === trail.length - 1
                ? <span className="text-txt">{b.t}</span>
                : <button onClick={() => setTrail(trail.slice(0, i + 1))} className="text-amber hover:underline">{b.t}</button>}
            </span>
          ))}
        </div>
      )}

      {/* PROMINENT provenance banner (was small footer text — promoted given
          the hallucination risk of ungrounded generations). */}
      <div className="border border-amber/60 bg-amber/10 rounded-md px-3 py-2 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <StatusBadge kind="ai" />
        <span className="text-amber font-bold uppercase tracking-wider">AI-generated map</span>
        <span className="text-mut">{data.source || "LLM"}{data.generated_at ? ` · generated ${new Date(data.generated_at).toLocaleString()}` : ""}</span>
        <span className="text-mut">Not sourced from filings unless marked <span className="text-green">✓ verified</span> — verify independently.</span>
        <div className="flex-1" />
        {snapshotTs && (
          <span className="text-amber">Viewing snapshot from {new Date(snapshotTs).toLocaleString()}
            <button onClick={() => load(current)} className="ml-2 underline">back to live</button>
          </span>
        )}
        {!snapshotTs && (
          <button onClick={() => load(current, true)} disabled={busy}
                  className="btn-ghost !py-1 text-xs" title="Discard the cached map and regenerate now">
            Regenerate
          </button>
        )}
      </div>

      <Methodology id="valueChain" className="mb-3" />

      {/* ── SPLC toolbar: one dataset, two views ──────────────────────────
          Bloomberg puts a Chart/Table switch and the relationship tabs at the
          top of SPLC, and the table is where the work happens. Ours had only
          the chart. */}
      <div className="hud px-3 py-2 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <span className="label-xs">Show as</span>
        <div className="flex items-center gap-1">
          {(["chart", "table"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`px-2.5 py-1 rounded border uppercase tracking-wider
                                text-[10px] transition-colors ${
                      mode === m
                        ? "border-amber text-amber bg-amber/10"
                        : "border-line2 text-mut hover:text-txt hover:border-mut"}`}>
              {m}
            </button>
          ))}
        </div>

        <span className="w-px h-4 bg-line2" />

        <span className="label-xs">Relationships</span>
        <div className="flex items-center gap-1 flex-wrap">
          {([["all", "All"], ["supplier", "Suppliers"], ["customer", "Customers"],
             ["competitor", "Peers"]] as const).map(([id, label]) => {
            const n = id === "all"
              ? entities.length
              : entities.filter((e) => e.roles.includes(id as Role)).length;
            return (
              <button key={id} onClick={() => setRoleTab(id as Role | "all")}
                      aria-pressed={roleTab === id}
                      disabled={n === 0}
                      title={n === 0 ? `No ${label.toLowerCase()} in this map` : undefined}
                      className={`px-2 py-1 rounded border text-[10px] uppercase
                                  tracking-wider transition-colors disabled:opacity-40 ${
                        roleTab === id
                          ? "border-amber text-amber bg-amber/10"
                          : "border-line2 text-mut hover:text-txt hover:border-mut"}`}>
                {label} <span className="num opacity-70">{n}</span>
              </button>
            );
          })}
        </div>

        <div className="flex-1" />
        <span className="text-mut">
          {mode === "chart"
            ? "Click a node to re-centre the map"
            : "Click a row to re-centre the map"}
        </span>
      </div>

      {diff && (
        <div className="border border-line2 rounded-md px-3 py-2 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="text-amber font-bold uppercase tracking-wider">Diff mode</span>
          <span className="text-mut">
            vs {new Date(compareTs!).toLocaleString()}
          </span>
          <span style={{ color: DIFF_COL.added }}>● {diff.added.length} added</span>
          <span style={{ color: DIFF_COL.removed }}>● {diff.removed.length} removed</span>
          <span style={{ color: DIFF_COL.changed }}>
            ● {diff.changed.length} changed (weight move ≥{diff.threshold}pp or role change)
          </span>
          <div className="flex-1" />
          <button onClick={() => setCompareTs(null)} className="underline hover:text-amber">
            Exit diff
          </button>
        </div>
      )}

      {/* Contagion path finder — routes across EVERY map generated so far. */}
      <div className="mb-3"><ContagionPathFinder seed={data.name} /></div>

      {/* Time-lapse: watch the chain evolve across stored generations. */}
      {chrono.length > 1 && (
        <div className="flex flex-wrap items-center gap-3 mb-3 panel-2 px-3 py-2 text-[11px]">
          <button onClick={() => {
                    if (playing) { setPlaying(false); return; }
                    // Restart from the beginning when parked at the end.
                    if (playIdx >= chrono.length - 1) setPlayIdx(0);
                    setPlaying(true);
                  }}
                  className="btn-ghost !py-1 flex items-center gap-1.5"
                  title="Play the chain forward through every stored generation">
            {playing ? <Pause size={12} /> : <Play size={12} />}
            {playing ? "Pause" : "Time-lapse"}
          </button>
          <input type="range" min={0} max={chrono.length - 1} value={playIdx}
                 aria-label="Scrub through stored generations"
                 onChange={(e) => { setPlaying(false); setPlayIdx(parseInt(e.target.value, 10)); }}
                 className="accent-amber flex-1 min-w-[140px] max-w-[320px]" />
          <span className="text-mut num whitespace-nowrap">
            {playIdx + 1}/{chrono.length}
            {chrono[playIdx]?.generated_at
              ? ` · ${new Date(chrono[playIdx].generated_at!).toLocaleString()}`
              : ""}
          </span>
          {(playing || snapshotTs) && (
            <button onClick={() => { setPlaying(false); setPlayIdx(0); framedRef.current = null; load(current); }}
                    className="underline hover:text-amber">back to live</button>
          )}
          <span className="text-mut/70">
            Frames are past AI generations, not quarterly filings — drift here is the
            model changing its mind as much as the chain changing.
          </span>
        </div>
      )}

      {/* Chain Fragility Score — a single brandable read on the chain. */}
      <div className="flex flex-wrap items-center gap-3 mb-3 panel-2 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="label-xs">Chain Fragility</span>
          <span className="num text-2xl font-bold" style={{ color: FRAG_COL }}>
            {fragility.coverage > 0 ? fragility.score : "—"}
          </span>
          <span className="text-[10px] text-mut">/100</span>
          {fragility.coverage > 0 && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border"
                  style={{ color: FRAG_COL, borderColor: `${FRAG_COL}80` }}>
              {fragility.band}
            </span>
          )}
        </div>
        {/* Bar */}
        <div className="h-1.5 w-28 rounded bg-panel overflow-hidden">
          <div className="h-full rounded" style={{
            width: `${fragility.coverage > 0 ? fragility.score : 0}%`, background: FRAG_COL }} />
        </div>
        <span className="text-[11px] text-mut flex-1 min-w-[200px]">
          {fragility.coverage > 0
            ? <>Higher = more brittle. Driven by {fragility.drivers.slice(0, 2).join("; ")}.</>
            : <>Not scoreable — the AI returned no exposure percentages for this chain.</>}
        </span>
        {fragility.coverage > 0 && (
          <span className="text-[10px] text-mut"
                title="Share of supplier/customer edges that carried a usable exposure weight. A low number means the score rests on thin evidence.">
            evidence {Math.round(fragility.coverage * 100)}% of edges
          </span>
        )}
      </div>

      {/* Toolbar. Split into SELF-CONTAINED groups: each group is an
          inline-flex that never breaks internally, and the container wraps
          group-by-group. The old single row used a flex-1 spacer, which on a
          narrow viewport ate a whole line and orphaned the export buttons
          onto a disconnected row. Groups are separated by a subtle divider so
          the reflow still reads as structure, not scatter. */}
      {/* Chart-only controls. The legend, edge weighting, graph search and
          fit/reset all describe the canvas; leaving them on screen in table
          mode is a row of buttons that do nothing to what you are reading. */}
      <div className={`flex-wrap items-center gap-x-3 gap-y-2 mb-3 text-[11px] text-mut ${
        mode === "table" ? "hidden" : "flex"}`}>
        {/* legend */}
        <span className="inline-flex items-center gap-3 whitespace-nowrap">
          <span><span style={{ color: COL.supplier }}>●</span> Suppliers</span>
          <span className="max-w-[160px] truncate"><span style={{ color: COL.company }}>●</span> {data.name}</span>
          <span><span style={{ color: COL.customer }}>●</span> Customers</span>
          <span><span style={{ color: COL.competitor }}>●</span> Competitors</span>
        </span>
        <span className="hidden sm:inline text-line2">|</span>
        <span className="opacity-80 whitespace-nowrap">solid ✓ = verified · dashed = AI-estimated</span>

        {/* Cross-module overlays: what you hold / who traded it / what broke. */}
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <button onClick={() => setOverlaysOn((v) => !v)}
                  title="Overlay your portfolio holdings, Big Sharks deal activity and matching news onto the graph"
                  className={`px-1.5 py-0.5 rounded border text-[10px] ${
                    overlaysOn ? "border-amber text-amber bg-amber/10" : "border-line2 text-mut hover:text-txt"}`}>
            Overlays
          </button>
          {overlaysOn && (
            <span className="text-[10px] text-mut">
              <span className="text-amber">◎</span> {heldCount} held ·{" "}
              <span className="text-green">▲</span> {dealCount} deals ·{" "}
              <span className="text-amber">●</span> {newsCount} in the news
            </span>
          )}
        </span>

        {/* edge-weight metric */}
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className="label-xs">Weight by</span>
          {(["pctRevenue", "pctCOGS", "estUSDValue"] as EdgeMetric[]).map((m) => (
            <button key={m} onClick={() => setEdgeMetric(m)}
                    title={`Scale edge thickness by ${EDGE_METRIC_LABEL[m]}`}
                    className={`px-1.5 py-0.5 rounded border text-[10px] ${
                      edgeMetric === m ? "border-amber text-amber bg-amber/10" : "border-line2 text-mut hover:text-txt"}`}>
              {EDGE_METRIC_LABEL[m]}
            </button>
          ))}
        </span>
        {missingMetric > 0 && (
          <span className="text-amber/90 whitespace-nowrap" title="These edges are drawn from another measure (or at base weight) because the AI didn't return the selected one — they are NOT necessarily small.">
            {missingMetric} edge{missingMetric > 1 ? "s" : ""} lack this measure
          </span>
        )}

        {/* search + snapshots */}
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          <input value={graphFilter} onChange={(e) => setGraphFilter(e.target.value)}
                 placeholder="Find in graph…" aria-label="Find in graph"
                 className="input-bare !py-1 !px-2 text-[11px] w-32" />
          {history.length > 1 && (
            <select value={snapshotTs ?? ""} aria-label="View a prior snapshot"
                    className="input-bare !py-1 !px-2 text-[11px] cursor-pointer w-40"
                    onChange={(e) => {
                      const ts = e.target.value;
                      if (!ts) { load(current); return; }
                      const entry = history.find((h) => h.generated_at === ts);
                      if (entry) viewSnapshot(entry);
                    }}>
              <option value="">Latest (live)</option>
              {history.map((h) => (
                <option key={h.generated_at ?? ""} value={h.generated_at ?? ""}>
                  {h.generated_at ? new Date(h.generated_at).toLocaleString() : "unknown"}
                </option>
              ))}
            </select>
          )}
          {history.length > 1 && !snapshotTs && (
            <select value={compareTs ?? ""} aria-label="Compare to a previous snapshot"
                    title="Highlight what changed since a previous generation"
                    className="input-bare !py-1 !px-2 text-[11px] cursor-pointer w-44"
                    onChange={(e) => setCompareTs(e.target.value || null)}>
              <option value="">Compare to previous…</option>
              {history.filter((h) => h.generated_at && h.generated_at !== data.generated_at).map((h) => (
                <option key={h.generated_at ?? ""} value={h.generated_at ?? ""}>
                  vs {h.generated_at ? new Date(h.generated_at).toLocaleString() : "unknown"}
                </option>
              ))}
            </select>
          )}
        </span>

        {/* view controls */}
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <button onClick={fitToView} className="hover:text-amber flex items-center gap-1"
                  title="Zoom/pan so every node is on screen">
            <Maximize2 size={11} />Fit
          </button>
          <button onClick={() => setView({ ...DEFAULT_VIEW })} className="hover:text-amber" title="Reset zoom/pan">
            Reset view
          </button>
        </span>

        {/* status + actions — ml-auto only once there is room for a right
            edge; below that it simply flows as the next wrapped group. */}
        <span className="inline-flex items-center gap-2 whitespace-nowrap lg:ml-auto">
          {pinnedAt && (
            <span className="text-amber border border-amber/50 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider">
              Pinned {new Date(pinnedAt).toLocaleDateString()}
            </span>
          )}
          <DataAge at={data.generated_at ?? fetchedAt} prefix="Generated" />
          <button onClick={togglePin} title={pinnedAt ? "Unpin — go back to live AI generations" : "Pin this exact map so AI regeneration can't silently change it"}
                  className="hover:text-amber flex items-center gap-1">
            {pinnedAt ? <PinOff size={12} /> : <Pin size={12} />}{pinnedAt ? "Unpin" : "Pin"}
          </button>
          <button onClick={() => exportCsv(data)} title="Export nodes + edges as CSV" className="hover:text-amber flex items-center gap-1">
            <Download size={12} />CSV
          </button>
          <button onClick={() => svgRef.current && exportSvg(svgRef.current, current)} title="Export as SVG" className="hover:text-amber">SVG</button>
          <button onClick={() => svgRef.current && exportPng(svgRef.current, current)} title="Export as PNG" className="hover:text-amber">PNG</button>
        </span>
      </div>

      {/* The table view. Kept as a sibling of the graph rather than a
          replacement for it: both read the same merged entity list, so
          switching views never refetches or loses the drill-down trail. */}
      {mode === "table" && (
        <ChainTable
          entities={entities}
          subject={data.name || current}
          generatedAt={data.generated_at ?? null}
          quotes={nodeQuotes}
          roleFilter={roleTab}
          onPick={(row) => {
            // Same behaviour as clicking a node: re-centre on that company.
            if (row.ticker) recenter(row.ticker, row.name);
          }} />
      )}

      {/* Graph + docked detail panel. The panel sits BESIDE the canvas on
          large screens so selecting a node never scrolls the graph out of
          view; below ~1024px it stacks underneath (still adjacent). */}
      <div className={`gap-3 ${mode === "table" ? "hidden" : "grid"} ${selected ? "lg:grid-cols-[minmax(0,1fr)_340px]" : "grid-cols-1"}`}>
      <div ref={containerRef}
           className="panel overflow-hidden touch-none select-none relative min-w-0"
           onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
           style={{ cursor: "grab", WebkitUserSelect: "none", userSelect: "none" }}>
        <svg ref={svgRef} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
             className="w-full" style={{ minWidth: 320, maxHeight: "72vh" }}>
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3"
                    orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L7,3 L0,6 Z" fill="#4b5563" />
            </marker>
          </defs>

          {/* Edges are drawn PER ROLE, not per column, so a merged entity
              that both supplies and buys gets an inbound AND an outbound
              arrow. Styling encodes exposure (width/opacity) and provenance
              (verified = solid, AI-estimated = dashed). */}
          {allNodes.filter((n) => n.roles.includes("supplier")).map((s, i) => {
            const m = edgeOf(s, "supplier");
            const w = edgeWidthFor(m.value, m.used, usdMax);
            return (
              <g key={`se${i}`} opacity={matchesFilter(s) ? 1 : 0.12}>
                <line x1={s.x + 78} y1={s.y} x2={CX - 90} y2={CY}
                      stroke={s.confidence === "verified" ? "#1fd286" : COL.supplier}
                      strokeOpacity={s.confidence === "verified" ? 0.9 : edgeOpacityFor(m.value, m.used, usdMax)}
                      strokeWidth={s.confidence === "verified" ? Math.max(2, w) : w}
                      strokeDasharray={s.confidence === "verified" ? undefined : "6 4"}
                      markerEnd="url(#arrow)" />
                <YoyMark x={(s.x + 78 + CX - 90) / 2} y={(s.y + CY) / 2}
                         yoy={s.metricsByRole.supplier?.yoyPct ?? null} />
              </g>
            );
          })}
          {allNodes.filter((n) => n.roles.includes("customer")).map((c, i) => {
            const m = edgeOf(c, "customer");
            const w = edgeWidthFor(m.value, m.used, usdMax);
            return (
              <g key={`ce${i}`} opacity={matchesFilter(c) ? 1 : 0.12}>
                <line x1={CX + 90} y1={CY} x2={c.x - 78} y2={c.y}
                      stroke={c.confidence === "verified" ? "#1fd286" : COL.customer}
                      strokeOpacity={c.confidence === "verified" ? 0.9 : edgeOpacityFor(m.value, m.used, usdMax)}
                      strokeWidth={c.confidence === "verified" ? Math.max(2, w) : w}
                      strokeDasharray={c.confidence === "verified" ? undefined : "6 4"}
                      markerEnd="url(#arrow)" />
                <YoyMark x={(CX + 90 + c.x - 78) / 2} y={(CY + c.y) / 2}
                         yoy={c.metricsByRole.customer?.yoyPct ?? null} />
              </g>
            );
          })}
          {allNodes.filter((n) => n.roles.includes("competitor")).map((c, i) => (
            <line key={`ke${i}`} x1={CX} y1={CY + 26} x2={c.x} y2={c.y - 18}
                  stroke={COL.competitor} strokeOpacity={0.3} strokeWidth={1.1}
                  opacity={matchesFilter(c) ? 1 : 0.12} strokeDasharray="4 3" />
          ))}

          <g>
            <rect x={CX - 90} y={CY - 26} width={180} height={52} rx={7}
                  fill="#1a1206" stroke={COL.company} strokeWidth={2} />
            <text x={CX} y={CY - 4} textAnchor="middle" fontSize={15} fill={COL.company}
                  fontWeight={700} fontFamily="JetBrains Mono, monospace">{data.ticker}</text>
            <text x={CX} y={CY + 14} textAnchor="middle" fontSize={9} fill="#c9a25a"
                  fontFamily="JetBrains Mono, monospace">
              {data.name.length > 24 ? data.name.slice(0, 23) + "…" : data.name}
            </text>
          </g>

          {/* Entities the previous generation had and this one dropped. They
              have no position in the current layout, so they're shown as a
              ghost row across the top rather than silently vanishing. */}
          {diff && diff.removed.map((r, i, arr) => {
            const gx = CX + (i - (arr.length - 1) / 2) * Math.min(180, (W - 200) / Math.max(arr.length, 1));
            return (
              <g key={`rm${r.key}`} opacity={0.75}>
                <title>{`Removed since the compared snapshot: ${r.name}`}</title>
                <rect x={gx - 78} y={9} width={156} height={32} rx={5}
                      fill="#11151b" stroke="#ff4d4f" strokeWidth={1.4} strokeDasharray="4 3" />
                <text x={gx} y={24} textAnchor="middle" fontSize={11} fill="#ff4d4f"
                      fontFamily="JetBrains Mono, monospace"
                      style={{ textDecoration: "line-through" }}>
                  {r.name.length > 20 ? r.name.slice(0, 19) + "…" : r.name}
                </text>
                <text x={gx} y={36} textAnchor="middle" fontSize={7.5} fill="#7d8694"
                      fontFamily="JetBrains Mono, monospace">removed</text>
              </g>
            );
          })}
          {allNodes.map((n) => (
            <Node key={n.key} x={n.x} y={n.y} label={n.name} note={n.note}
                  pct={n.primaryRole === "competitor" ? null : n.revenue_pct}
                  color={COL[n.primaryRole]} onClick={() => pick(n)} roles={n.roles}
                  verified={n.confidence === "verified"} dimmed={!matchesFilter(n)}
                  disputed={lookupReportCount(reportCounts, n.key)}
                  diffStatus={diff?.byKey.get(n.key)?.status}
                  overlay={overlayFor(overlays, n.key)}
                  sourced={evidence.get(n.key)?.length ?? 0}
                  onHover={(e) => showTip(e, n, n.primaryRole)} onLeave={hideTip}
                  selected={selected?.key === n.key} />
          ))}
        </svg>

        {/* Hover tooltip — the FULL label/note/exposure, which the node box
            truncates at 20/26 chars. HTML (not SVG) so it wraps normally and
            isn't clipped by the viewBox; pointer-events:none so it can never
            steal the hover it's describing. */}
        {hover && (
          <div role="tooltip"
               className="absolute z-20 pointer-events-none max-w-[280px] rounded border
                          border-line2 bg-bg/95 backdrop-blur-sm px-2.5 py-2 shadow-panel"
               style={{
                 left: hover.flipX ? undefined : hover.cx + 14,
                 right: hover.flipX ? `calc(100% - ${hover.cx - 14}px)` : undefined,
                 top: hover.flipY ? undefined : hover.cy + 14,
                 bottom: hover.flipY ? `calc(100% - ${hover.cy - 14}px)` : undefined,
               }}>
            <div className="flex items-center gap-1.5 mb-1">
              <span style={{ color: COL[hover.role] }}>●</span>
              <span className="text-[10px] uppercase tracking-wider text-mut">{hover.role}</span>
              {hover.node.confidence === "verified"
                ? <span className="text-[9px] text-green border border-green/50 rounded px-1">✓ verified</span>
                : <span className="text-[9px] text-amber border border-amber/40 rounded px-1">AI est.</span>}
            </div>
            <div className="text-xs font-semibold text-txt break-words">{hover.node.name}</div>
            {(() => {
              const m = hover.node.metricsByRole[hover.role];
              if (!m) return null;
              return (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {m.pctRevenue != null && (
                    <div className="text-[11px] text-amber">≈{fmtNum(m.pctRevenue, 1)}% of revenue (est.)</div>
                  )}
                  {m.pctCOGS != null && (
                    <div className="text-[11px] text-amber">≈{fmtNum(m.pctCOGS, 1)}% of input costs (est.)</div>
                  )}
                  {m.estUSDValue != null && (
                    <div className="text-[11px] text-amber">≈{fmtUsd(m.estUSDValue)}/yr (est.)</div>
                  )}
                  {m.yoyPct != null && (
                    <div className={`text-[11px] ${m.yoyPct >= 0 ? "text-green" : "text-red"}`}>
                      {m.yoyPct >= 0 ? "▲" : "▼"} {fmtNum(Math.abs(m.yoyPct), 1)}% YoY (est.)
                    </div>
                  )}
                </div>
              );
            })()}
            {hover.node.note && (
              <div className="text-[11px] text-mut mt-1 break-words">{hover.node.note}</div>
            )}
            {hover.node.ticker && (
              <div className="text-[10px] text-mut mt-1">Ticker hint: <span className="text-txt">{hover.node.ticker}</span></div>
            )}
            {(() => {
              const o = overlayFor(overlays, hover.node.key);
              if (!o) return null;
              return (
                <>
                  {o.held && (
                    <div className="text-[10px] text-amber mt-1">
                      ◎ In your portfolio: {fmtNum(o.held.qty, 0)} {o.held.ticker}
                      {o.held.pnlPct != null && (
                        <span className={o.held.pnlPct >= 0 ? "text-green" : "text-red"}> {fmtPct(o.held.pnlPct)}</span>
                      )}
                    </div>
                  )}
                  {o.deals.slice(0, 2).map((d, i) => (
                    <div key={i} className={`text-[10px] mt-0.5 ${d.side === "sell" ? "text-red" : "text-green"}`}>
                      {d.side === "sell" ? "▼" : "▲"} {d.kind} {d.side !== "unknown" ? d.side : ""} — {d.label}
                      {d.value != null && <span className="text-mut"> ({humanNumber(d.value)})</span>}
                    </div>
                  ))}
                  {o.news.slice(0, 2).map((n, i) => (
                    <div key={i} className="text-[10px] text-mut mt-0.5 line-clamp-2">› {n.title}</div>
                  ))}
                </>
              );
            })()}
            {lookupReportCount(reportCounts, hover.node.key) > 1 && (
              <div className="text-[10px] text-red mt-1">
                ⚑ Flagged as wrong by {lookupReportCount(reportCounts, hover.node.key)} reports
              </div>
            )}
            {(() => {
              const d = diff?.byKey.get(hover.node.key);
              if (!d || d.status === "same") return null;
              return (
                <div className="mt-1 text-[10px]" style={{ color: DIFF_COL[d.status] }}>
                  {d.status === "added" && "＋ New since the compared snapshot"}
                  {d.status === "removed" && "－ Removed since the compared snapshot"}
                  {d.status === "changed" && (
                    <>
                      ~ Changed:
                      {d.weightDelta != null && (
                        <> weight {d.weightDelta >= 0 ? "+" : ""}{fmtNum(d.weightDelta, 1)}pp
                          {d.weightRole ? ` (${d.weightRole})` : ""}</>
                      )}
                      {d.rolesAdded.length > 0 && <> · gained {d.rolesAdded.join(", ")}</>}
                      {d.rolesRemoved.length > 0 && <> · lost {d.rolesRemoved.join(", ")}</>}
                    </>
                  )}
                </div>
              );
            })()}
            <div className="text-[9.5px] text-mut/70 mt-1.5">Click for drill-down</div>
          </div>
        )}

        {/* Minimap: whole-graph overview + current viewport rectangle. Click
            anywhere on it to centre the view there. Only worth the pixels
            once the graph is big enough to overflow. */}
        {suppliers.length + customers.length + competitors.length > 8 && (
          <div className="absolute bottom-2 right-2 rounded border border-line2 bg-bg/85 backdrop-blur-sm p-1">
            <svg width={148} height={148 * (H / W)} viewBox={`0 0 ${W} ${H}`}
                 role="img" aria-label="Graph minimap — click to centre the view"
                 style={{ cursor: "crosshair", display: "block" }}
                 onPointerDown={(e) => {
                   // Own the gesture: don't let it start a canvas pan.
                   e.stopPropagation();
                   const r = e.currentTarget.getBoundingClientRect();
                   const gx = ((e.clientX - r.left) / r.width) * W;
                   const gy = ((e.clientY - r.top) / r.height) * H;
                   setView((v) => ({ ...v, x: gx - v.w / 2, y: gy - v.h / 2 }));
                 }}>
              <rect x={0} y={0} width={W} height={H} fill="#0c0e12" />
              {suppliers.map((s, i) => (
                <rect key={`ms${i}`} x={s.x - 78} y={s.y - 16} width={156} height={32}
                      fill={COL.supplier} opacity={0.55} />
              ))}
              {customers.map((c, i) => (
                <rect key={`mc${i}`} x={c.x - 78} y={c.y - 16} width={156} height={32}
                      fill={COL.customer} opacity={0.55} />
              ))}
              {competitors.map((c, i) => (
                <rect key={`mk${i}`} x={c.x - 78} y={c.y - 16} width={156} height={32}
                      fill={COL.competitor} opacity={0.55} />
              ))}
              <rect x={CX - 90} y={CY - 26} width={180} height={52} fill={COL.company} opacity={0.8} />
              {/* current viewport */}
              <rect x={view.x} y={view.y} width={view.w} height={view.h}
                    fill="none" stroke="#ffb000" strokeWidth={8} opacity={0.9} />
            </svg>
          </div>
        )}
      </div>

        {selected && (
          <div className="min-w-0 lg:max-h-[72vh]">
            <NodeDetail node={selected} parentTicker={current} chainTicker={current}
                        onClose={() => setSelected(null)} onRecenter={recenter}
                        overlay={overlayFor(overlays, selected.key)}
                        evidence={evidence.get(selected.key)} chain={data}
                        onReported={() => {
                          // Refresh badges so the new flag counts immediately.
                          api.vcReportCounts(current)
                            .then((r) => setReportCounts(r.counts ?? {}))
                            .catch(() => {});
                        }} />
          </div>
        )}
      </div>

      <div className="text-[10.5px] text-mut mt-2">
        Illustrative map generated by AI ({data.source || "LLM"})
        {data.generated_at ? ` on ${new Date(data.generated_at).toLocaleString()}` : ""} —
        not sourced from filings or procurement data; relationships and percentages are
        the model&apos;s best estimates. Click a node for details, drill-down, and to
        report wrong relationships. Verify independently before using in research.
      </div>
    </div>
  );
}
