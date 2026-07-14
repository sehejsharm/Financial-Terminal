"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Download, ExternalLink, Flag, Pin, PinOff, X } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { api, type ChainNode, type Quote, type ValueChain } from "@/lib/api";
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
const W = 1200;
const H = 780;
const CX = W / 2;
const CY = 340;

const COL = {
  company: "#ffb000",
  supplier: "#3b82f6",
  customer: "#22c55e",
  competitor: "#a78bfa",
};

type Role = "supplier" | "customer" | "competitor";
type Selected = ChainNode & { role: Role };
type Cand = { symbol: string; name: string; source: string };

// Materiality → edge visuals: thicker/brighter edges for relationships the
// AI estimates as a larger share of revenue / input costs.
function edgeWidth(pct?: number | null): number {
  return pct != null ? Math.max(1.2, Math.min(6, 1 + pct / 10)) : 1.2;
}
function edgeOpacity(pct?: number | null): number {
  return pct != null ? Math.min(0.9, 0.3 + pct / 80) : 0.35;
}

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

async function resolveNode(node: ChainNode): Promise<Cand[]> {
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
  const lines = ["role,name,note,revenue_pct,ticker_hint"];
  const push = (role: Role, ns?: ChainNode[]) =>
    (ns ?? []).forEach((n) => lines.push(
      [role, esc(n.name), esc(n.note), n.revenue_pct ?? "", esc(n.ticker)].join(","),
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
function Node({ x, y, label, note, pct, color, onClick, selected }: {
  x: number; y: number; label: string; note?: string; pct?: number | null;
  color: string; onClick: () => void; selected: boolean;
}) {
  const sub = pct != null ? `≈${fmtNum(pct, 0)}% · ${note ?? ""}` : note;
  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      <title>{sub ? `${label} — ${sub}` : label}</title>
      <rect x={x - 78} y={y - 16} width={156} height={32} rx={5}
            fill={selected ? "#1c2129" : "#11151b"} stroke={color}
            strokeWidth={selected ? 2.4 : 1.4} />
      <text x={x} y={y - 1} textAnchor="middle" fontSize={12}
            fill="#e8ecf2" fontWeight={600} fontFamily="JetBrains Mono, monospace">
        {label.length > 20 ? label.slice(0, 19) + "…" : label}
      </text>
      {sub && (
        <text x={x} y={y + 11} textAnchor="middle" fontSize={8.5}
              fill="#7d8694" fontFamily="JetBrains Mono, monospace">
          {sub.length > 26 ? sub.slice(0, 25) + "…" : sub}
        </text>
      )}
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

  async function flag() {
    setReporting(true);
    try {
      await api.reportValueChain(chainTicker, { node_name: node.name, role: node.role });
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

  return (
    <div className="panel-2 p-3 mt-3 flex items-start gap-3">
      <span className="mt-1" style={{ color: COL[node.role] }}>●</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{node.name}
          <span className="text-mut font-normal ml-2 text-[11px] uppercase tracking-wider">{node.role}</span>
          {node.revenue_pct != null && (
            <span className="text-amber font-normal ml-2 text-[11px]">≈{fmtNum(node.revenue_pct, 0)}% exposure (AI est.)</span>
          )}
        </div>
        {node.note && <div className="text-xs text-mut mt-0.5">{node.note}</div>}
        {quote && quote.price != null && best && (
          <div className="text-xs mt-1">
            <span className="text-mut">{best}</span>{" "}
            <span className="num">{fmtNum(quote.price, 2)}</span>{" "}
            {quote.change_pct != null && (
              <span className={`num ${quote.change_pct >= 0 ? "text-green" : "text-red"}`}>{fmtPct(quote.change_pct)}</span>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
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
      </div>
      <button onClick={flag} disabled={reported || reporting}
              title="Flag this relationship as wrong — goes to the admin review queue"
              className={`flex items-center gap-1 text-[11px] whitespace-nowrap ${reported ? "text-green" : "text-mut hover:text-red"}`}>
        <Flag size={12} />
        {reported ? "Reported" : reporting ? "…" : "Report"}
      </button>
      <button onClick={onClose} className="text-mut hover:text-txt"><X size={14} /></button>
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

  const load = useCallback((t: string) => {
    setBusy(true); setErr(null); setData(null); setSelected(null); setPinnedAt(null);
    const pin = loadPin(t);
    if (pin) {
      setData(pin.data); setFetchedAt(pin.pinnedAt); setPinnedAt(pin.pinnedAt); setBusy(false);
      return;
    }
    api.valueChain(t)
      .then((m) => { setData(m.data); setFetchedAt(m.fetchedAt); })
      .catch((e) => setErr(e?.detail || "Value-chain mapping failed."))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => { load(current); }, [current, load]);

  function recenter(symbol: string, name: string) {
    setTrail((tr) => [...tr, { t: symbol, name }]);
  }

  function togglePin() {
    if (!data) return;
    if (pinnedAt) { clearPin(current); load(current); return; }
    savePin(current, data);
    setPinnedAt(Date.now());
  }

  if (busy) return <div className="text-mut text-xs">Mapping value chain (AI)…</div>;
  if (err) return <div className="text-red text-sm">{err}</div>;
  if (!data) return null;

  const supList = (data.suppliers ?? []).slice(0, 10);
  const cusList = (data.customers ?? []).slice(0, 12);
  const cmpList = (data.competitors ?? []).slice(0, 8);

  const sGap = Math.min(70, (H - 140) / Math.max(supList.length, 1));
  const cGap = Math.min(60, (H - 140) / Math.max(cusList.length, 1));

  const suppliers = supList.map((it, i) => ({ ...it, x: 170, y: 70 + i * sGap }));
  const customers = cusList.map((it, i) => ({ ...it, x: W - 170, y: 70 + i * cGap }));
  const competitors = cmpList.map((it, i, arr) => ({
    ...it,
    x: CX + (i - (arr.length - 1) / 2) * Math.min(180, (W - 200) / Math.max(arr.length, 1)),
    y: H - 60,
  }));

  const pick = (n: ChainNode, role: Role) =>
    setSelected((cur) => (cur?.name === n.name && cur.role === role ? null : { ...n, role }));

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

      <div className="flex flex-wrap items-center gap-4 mb-3 text-[11px] text-mut">
        <span><span style={{ color: COL.supplier }}>●</span> Suppliers</span>
        <span><span style={{ color: COL.company }}>●</span> {data.name}</span>
        <span><span style={{ color: COL.customer }}>●</span> Customers</span>
        <span><span style={{ color: COL.competitor }}>●</span> Competitors</span>
        <span className="opacity-80">edge weight = AI-estimated exposure</span>
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

      <div className="panel overflow-x-auto">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 700 }}>
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3"
                    orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L7,3 L0,6 Z" fill="#4b5563" />
            </marker>
          </defs>

          {suppliers.map((s, i) => (
            <line key={`se${i}`} x1={s.x + 78} y1={s.y} x2={CX - 90} y2={CY}
                  stroke={COL.supplier} strokeOpacity={edgeOpacity(s.revenue_pct)}
                  strokeWidth={edgeWidth(s.revenue_pct)} markerEnd="url(#arrow)" />
          ))}
          {customers.map((c, i) => (
            <line key={`ce${i}`} x1={CX + 90} y1={CY} x2={c.x - 78} y2={c.y}
                  stroke={COL.customer} strokeOpacity={edgeOpacity(c.revenue_pct)}
                  strokeWidth={edgeWidth(c.revenue_pct)} markerEnd="url(#arrow)" />
          ))}
          {competitors.map((c, i) => (
            <line key={`ke${i}`} x1={CX} y1={CY + 26} x2={c.x} y2={c.y - 18}
                  stroke={COL.competitor} strokeOpacity={0.3} strokeWidth={1.1} strokeDasharray="4 3" />
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

          {suppliers.map((s, i) => (
            <Node key={`s${i}`} x={s.x} y={s.y} label={s.name} note={s.note} pct={s.revenue_pct}
                  color={COL.supplier} onClick={() => pick(s, "supplier")}
                  selected={selected?.name === s.name && selected.role === "supplier"} />
          ))}
          {customers.map((c, i) => (
            <Node key={`c${i}`} x={c.x} y={c.y} label={c.name} note={c.note} pct={c.revenue_pct}
                  color={COL.customer} onClick={() => pick(c, "customer")}
                  selected={selected?.name === c.name && selected.role === "customer"} />
          ))}
          {competitors.map((c, i) => (
            <Node key={`k${i}`} x={c.x} y={c.y} label={c.name} note={c.note}
                  color={COL.competitor} onClick={() => pick(c, "competitor")}
                  selected={selected?.name === c.name && selected.role === "competitor"} />
          ))}
        </svg>
      </div>

      {selected && (
        <NodeDetail node={selected} parentTicker={current} chainTicker={current}
                    onClose={() => setSelected(null)} onRecenter={recenter} />
      )}

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
