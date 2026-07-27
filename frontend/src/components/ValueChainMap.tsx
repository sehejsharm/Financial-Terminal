"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Download, ExternalLink, Flag, Maximize2, Pin, PinOff, X } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { StatusBadge } from "@/components/StatusBadge";
import { api, type ChainNode, type Quote, type ValueChain, type VcHistoryEntry } from "@/lib/api";
import {
  clamp, CX, CY, DEFAULT_VIEW, fitView, H, MAX_W, mergeEntities, MIN_W, W, zoomAt,
  type MergedEntity, type Role, type View,
} from "@/lib/valueChainGraph";
import { fmtNum, fmtPct } from "@/lib/utils";

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

// Materiality → edge visuals: thicker/brighter edges for relationships the
// AI estimates as a larger share of revenue / input costs.
function edgeWidth(pct?: number | null): number {
  return pct != null ? Math.max(1.2, Math.min(6, 1 + pct / 10)) : 1.2;
}
function edgeOpacity(pct?: number | null): number {
  return pct != null ? Math.min(0.9, 0.3 + pct / 80) : 0.35;
}

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
  const lines = ["role,roles,name,note,revenue_pct,ticker_hint,confidence,verified_at"];
  const push = (role: Role, ns?: ChainNode[]) =>
    (ns ?? []).forEach((n) => lines.push(
      [role, esc((n.roles ?? [role]).join("|")), esc(n.name), esc(n.note),
       n.revenue_pct ?? "", esc(n.ticker),
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

// ── node box ────────────────────────────────────────────────────────────────
function Node({ x, y, label, note, pct, color, onClick, selected, verified, dimmed,
                onHover, onLeave, roles = [] }: {
  x: number; y: number; label: string; note?: string; pct?: number | null;
  color: string; onClick: () => void; selected: boolean;
  verified?: boolean; dimmed?: boolean; roles?: Role[];
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
    </g>
  );
}

// ── drill-down panel ────────────────────────────────────────────────────────
function NodeDetail({ node, parentTicker, chainTicker, onClose, onRecenter }: {
  node: Selected; parentTicker: string; chainTicker: string;
  onClose: () => void; onRecenter: (symbol: string, name: string) => void;
}) {
  const router = useRouter();
  const [cands, setCands] = useState<Cand[] | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [reported, setReported] = useState(false);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    let alive = true;
    setCands(null); setQuote(null); setShowOther(false); setReported(false);
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
      });
      setReported(true);
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
      {node.roles.some((r) => node.pctByRole[r] != null) && (
        <div className="flex flex-col gap-0.5">
          {node.roles.map((r) => node.pctByRole[r] != null && (
            <div key={r} className="text-[11px] text-amber">
              ≈{fmtNum(node.pctByRole[r], 1)}% {r === "supplier" ? "of input costs" : "of revenue"}
              <span className="text-mut"> ({r}, AI est.)</span>
            </div>
          ))}
        </div>
      )}
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

      {headlines.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {headlines.map((h, i) => (
            <a key={i} href={h.link} target="_blank" rel="noopener noreferrer"
               className="block text-[11px] text-mut hover:text-amber line-clamp-2">› {h.title}</a>
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

      <button onClick={flag} disabled={reported || reporting}
              title="Flag this relationship as wrong — goes to the admin review queue"
              className={`flex items-center gap-1 text-[11px] mt-auto pt-1 ${reported ? "text-green" : "text-mut hover:text-red"}`}>
        <Flag size={12} />
        {reported ? "Reported" : reporting ? "…" : "Report"}
      </button>
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
  const [selected, setSelected] = useState<Selected | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // New seed ticker (from the terminal search) resets the trail.
  useEffect(() => { setTrail([]); }, [ticker]);

  // History snapshots + zoom/pan + in-graph filter (flagship upgrades).
  const [history, setHistory] = useState<VcHistoryEntry[]>([]);
  const [snapshotTs, setSnapshotTs] = useState<string | null>(null); // viewing a prior version
  const [graphFilter, setGraphFilter] = useState("");
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
    { node: ChainNode; role: Role; cx: number; cy: number; flipX: boolean; flipY: boolean } | null
  >(null);

  const showTip = useCallback((e: React.MouseEvent | React.FocusEvent,
                               node: ChainNode, role: Role) => {
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
    setBusy(true); setErr(null); setData(null); setSelected(null); setPinnedAt(null);
    setSnapshotTs(null); setView({ ...DEFAULT_VIEW });
    const pin = !refresh && loadPin(t);
    if (pin) {
      setData(pin.data); setFetchedAt(pin.pinnedAt); setPinnedAt(pin.pinnedAt); setBusy(false);
      return;
    }
    api.valueChain(t, refresh)
      .then((m) => { if (loadReqRef.current === reqId) { setData(m.data); setFetchedAt(m.fetchedAt); } })
      .catch((e) => { if (loadReqRef.current === reqId) setErr(e?.detail || "Value-chain mapping failed."); })
      .finally(() => { if (loadReqRef.current === reqId) setBusy(false); });
    api.vcHistory(t)
      .then((h) => { if (loadReqRef.current === reqId) setHistory(h); })
      .catch(() => { if (loadReqRef.current === reqId) setHistory([]); });
  }, []);

  useEffect(() => { load(current); }, [current, load]);

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

  const matchesFilter = (n: ChainNode) => {
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
  const layout = useMemo(() => {
    if (!data) return null;
    const merged = mergeEntities(data);
    const supList = merged.filter((e) => e.primaryRole === "supplier").slice(0, 10);
    const cusList = merged.filter((e) => e.primaryRole === "customer").slice(0, 12);
    const cmpList = merged.filter((e) => e.primaryRole === "competitor").slice(0, 8);
    const sGap = Math.min(70, (H - 140) / Math.max(supList.length, 1));
    const cGap = Math.min(60, (H - 140) / Math.max(cusList.length, 1));
    return {
      suppliers: supList.map((it, i): Placed => ({ ...it, x: 170, y: 70 + i * sGap })),
      customers: cusList.map((it, i): Placed => ({ ...it, x: W - 170, y: 70 + i * cGap })),
      competitors: cmpList.map((it, i, arr): Placed => ({
        ...it,
        x: CX + (i - (arr.length - 1) / 2) * Math.min(180, (W - 200) / Math.max(arr.length, 1)),
        y: H - 60,
      })),
    };
  }, [data]);

  /** Frame every node — the escape hatch when a 30-node map runs off-canvas. */
  const fitToView = useCallback(() => {
    if (!layout) { setView({ ...DEFAULT_VIEW }); return; }
    setView(fitView([
      ...layout.suppliers, ...layout.customers, ...layout.competitors,
      { x: CX, y: CY },   // always keep the subject company in frame
    ]));
  }, [layout]);

  if (busy) return <div className="text-mut text-xs">Mapping value chain (AI)…</div>;
  if (err) return <div className="text-red text-sm">{err}</div>;
  if (!data || !layout) return null;

  const { suppliers, customers, competitors } = layout;
  // One flat list — edges are keyed off each entity's ROLES, not the column
  // it happens to be drawn in.
  const allNodes: Placed[] = [...suppliers, ...customers, ...competitors];

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

      <div className="flex flex-wrap items-center gap-4 mb-3 text-[11px] text-mut">
        <span><span style={{ color: COL.supplier }}>●</span> Suppliers</span>
        <span><span style={{ color: COL.company }}>●</span> {data.name}</span>
        <span><span style={{ color: COL.customer }}>●</span> Customers</span>
        <span><span style={{ color: COL.competitor }}>●</span> Competitors</span>
        <span className="opacity-80">solid ✓ = admin-verified · others = AI-estimated (weight = est. exposure)</span>
        <input value={graphFilter} onChange={(e) => setGraphFilter(e.target.value)}
               placeholder="Find in graph…" className="input-bare !py-1 !px-2 text-[11px] w-32" />
        {history.length > 1 && (
          <select value={snapshotTs ?? ""} className="input-bare !py-1 !px-2 text-[11px] cursor-pointer w-44"
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
        <button onClick={fitToView} className="hover:text-amber flex items-center gap-1"
                title="Zoom/pan so every node is on screen">
          <Maximize2 size={11} />Fit
        </button>
        <button onClick={() => setView({ ...DEFAULT_VIEW })} className="hover:text-amber" title="Reset zoom/pan">
          Reset view
        </button>
        <div className="flex-1" />
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
      </div>

      {/* Graph + docked detail panel. The panel sits BESIDE the canvas on
          large screens so selecting a node never scrolls the graph out of
          view; below ~1024px it stacks underneath (still adjacent). */}
      <div className={`grid gap-3 ${selected ? "lg:grid-cols-[minmax(0,1fr)_340px]" : "grid-cols-1"}`}>
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
          {allNodes.filter((n) => n.roles.includes("supplier")).map((s, i) => (
            <line key={`se${i}`} x1={s.x + 78} y1={s.y} x2={CX - 90} y2={CY}
                  stroke={s.confidence === "verified" ? "#1fd286" : COL.supplier}
                  strokeOpacity={s.confidence === "verified" ? 0.9 : edgeOpacity(s.pctByRole.supplier)}
                  strokeWidth={s.confidence === "verified" ? Math.max(2, edgeWidth(s.pctByRole.supplier)) : edgeWidth(s.pctByRole.supplier)}
                  strokeDasharray={s.confidence === "verified" ? undefined : "6 4"}
                  opacity={matchesFilter(s) ? 1 : 0.12}
                  markerEnd="url(#arrow)" />
          ))}
          {allNodes.filter((n) => n.roles.includes("customer")).map((c, i) => (
            <line key={`ce${i}`} x1={CX + 90} y1={CY} x2={c.x - 78} y2={c.y}
                  stroke={c.confidence === "verified" ? "#1fd286" : COL.customer}
                  strokeOpacity={c.confidence === "verified" ? 0.9 : edgeOpacity(c.pctByRole.customer)}
                  strokeWidth={c.confidence === "verified" ? Math.max(2, edgeWidth(c.pctByRole.customer)) : edgeWidth(c.pctByRole.customer)}
                  strokeDasharray={c.confidence === "verified" ? undefined : "6 4"}
                  opacity={matchesFilter(c) ? 1 : 0.12}
                  markerEnd="url(#arrow)" />
          ))}
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

          {allNodes.map((n) => (
            <Node key={n.key} x={n.x} y={n.y} label={n.name} note={n.note}
                  pct={n.primaryRole === "competitor" ? null : n.revenue_pct}
                  color={COL[n.primaryRole]} onClick={() => pick(n)} roles={n.roles}
                  verified={n.confidence === "verified"} dimmed={!matchesFilter(n)}
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
            {hover.node.revenue_pct != null && (
              <div className="text-[11px] text-amber mt-0.5">
                ≈{fmtNum(hover.node.revenue_pct, 1)}%{" "}
                {hover.role === "supplier" ? "of input costs" : "of revenue"} (est.)
              </div>
            )}
            {hover.node.note && (
              <div className="text-[11px] text-mut mt-1 break-words">{hover.node.note}</div>
            )}
            {hover.node.ticker && (
              <div className="text-[10px] text-mut mt-1">Ticker hint: <span className="text-txt">{hover.node.ticker}</span></div>
            )}
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
                        onClose={() => setSelected(null)} onRecenter={recenter} />
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
