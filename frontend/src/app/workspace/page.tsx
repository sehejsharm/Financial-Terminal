"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";

import { News } from "@/components/News";
import { PriceChart } from "@/components/PriceChart";
import { Shell } from "@/components/Shell";
import { ValueChainMap } from "@/components/ValueChainMap";
import { api, type Mover, type Snapshot, type WorkspaceLayout, type WorkspacePane } from "@/lib/api";
import { fmtNum, fmtPct, formatPercent, humanNumber } from "@/lib/utils";

/** Multi-pane workspace: 1-4 side-by-side widgets (chart / news / snapshot /
 *  value chain / movers), drag the dividers to resize, save named layouts
 *  per user and restore them on login. */

const WIDGETS = ["chart", "news", "snapshot", "valuechain", "movers"] as const;
type WidgetKind = typeof WIDGETS[number];
const WIDGET_LABELS: Record<WidgetKind, string> = {
  chart: "Chart", news: "News", snapshot: "Snapshot",
  valuechain: "Value chain", movers: "Movers",
};
const NEEDS_TICKER: Record<WidgetKind, boolean> = {
  chart: true, news: true, snapshot: true, valuechain: true, movers: false,
};

function ChartWidget({ ticker }: { ticker: string }) {
  const [candles, setCandles] = useState<any[]>([]);
  useEffect(() => {
    api.history(ticker, "1Y").then((h) => setCandles(h?.candles ?? [])).catch(() => setCandles([]));
  }, [ticker]);
  return <PriceChart data={candles} height={320} />;
}

function SnapshotWidget({ ticker }: { ticker: string }) {
  const [s, setS] = useState<Snapshot | null>(null);
  useEffect(() => {
    setS(null);
    api.snapshot(ticker).then(setS).catch(() => setS(null));
  }, [ticker]);
  if (!s) return <div className="text-mut text-xs">Loading…</div>;
  const rows: [string, string][] = [
    ["Price", fmtNum(s.price as number, 2)],
    ["Mkt cap", humanNumber(s.market_cap as number)],
    ["P/E", fmtNum(s.trailing_pe as number, 1)],
    ["Beta", fmtNum(s.beta as number, 2)],
    ["ROE", formatPercent(s.roe as number, { fraction: true })],
    ["Div yield", formatPercent(s.dividend_yield as number)],
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {rows.map(([l, v]) => (
        <div key={l} className="panel-2 p-2">
          <div className="label-xs">{l}</div>
          <div className="num text-sm">{v}</div>
        </div>
      ))}
      <div className="col-span-2 text-xs text-mut">{(s.name as string) ?? ticker} · {(s.sector as string) ?? "—"}</div>
    </div>
  );
}

function MoversWidget() {
  const [rows, setRows] = useState<Mover[]>([]);
  useEffect(() => {
    api.movers("gainers", 8).then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([]));
  }, []);
  return (
    <div className="flex flex-col gap-1">
      {rows.length === 0 && <div className="text-mut text-xs">No data.</div>}
      {rows.map((m, i) => {
        const cp = Number(m.change_pct ?? 0);
        return (
          <div key={i} className="flex justify-between text-sm px-1 py-0.5">
            <span className="truncate">{String(m.symbol ?? "")}</span>
            <span className={`num ${cp >= 0 ? "text-green" : "text-red"}`}>{fmtPct(cp)}</span>
          </div>
        );
      })}
    </div>
  );
}

function PaneView({ pane }: { pane: WorkspacePane }) {
  const t = (pane.ticker || "RELIANCE.NS").toUpperCase();
  switch (pane.widget as WidgetKind) {
    case "chart": return <ChartWidget ticker={t} />;
    case "news": return <News ticker={t} />;
    case "snapshot": return <SnapshotWidget ticker={t} />;
    case "valuechain": return <ValueChainMap ticker={t} />;
    case "movers": return <MoversWidget />;
    default: return <div className="text-mut text-xs">Unknown widget.</div>;
  }
}

const DEFAULT_PANES: WorkspacePane[] = [
  { widget: "chart", ticker: "RELIANCE.NS" },
  { widget: "news", ticker: "RELIANCE.NS" },
];

export default function WorkspacePage() {
  const [panes, setPanes] = useState<WorkspacePane[]>(DEFAULT_PANES);
  const [split, setSplit] = useState<number[]>([1, 1]);
  const [layouts, setLayouts] = useState<WorkspaceLayout[]>([]);
  const [saveName, setSaveName] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ idx: number; startX: number; left: number; right: number } | null>(null);

  useEffect(() => {
    api.workspaces().then((w) => {
      setLayouts(w.layouts);
      if (w.layouts.length) applyLayout(w.layouts[0]);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyLayout(l: WorkspaceLayout) {
    setPanes(l.panes.length ? l.panes : DEFAULT_PANES);
    setSplit(l.split.length === l.panes.length ? l.split : l.panes.map(() => 1));
  }

  async function persist(next: WorkspaceLayout[]) {
    setLayouts(next);
    try { await api.saveWorkspaces(next); } catch { /* keep local */ }
  }

  function saveCurrent() {
    const name = saveName.trim() || `Layout ${layouts.length + 1}`;
    const l: WorkspaceLayout = {
      id: `${Date.now()}`, name, panes, split,
    };
    persist([...layouts.filter((x) => x.name !== name), l]);
    setSaveName("");
  }

  function setPane(i: number, patch: Partial<WorkspacePane>) {
    setPanes((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  function addPane() {
    if (panes.length >= 4) return;
    setPanes((ps) => [...ps, { widget: "news", ticker: "RELIANCE.NS" }]);
    setSplit((s) => [...s, 1]);
  }

  function removePane(i: number) {
    if (panes.length <= 1) return;
    setPanes((ps) => ps.filter((_, j) => j !== i));
    setSplit((s) => s.filter((_, j) => j !== i));
  }

  // Divider drag: adjust the two neighboring fractions.
  const onDragStart = useCallback((idx: number, e: React.PointerEvent) => {
    dragRef.current = { idx, startX: e.clientX, left: split[idx], right: split[idx + 1] };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [split]);

  const onDragMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = containerRef.current;
    if (!d || !el) return;
    const total = d.left + d.right;
    const frac = (e.clientX - d.startX) / el.clientWidth * split.reduce((a, b) => a + b, 0);
    const left = Math.min(Math.max(d.left + frac, total * 0.15), total * 0.85);
    setSplit((s) => s.map((v, i) => (i === d.idx ? left : i === d.idx + 1 ? total - left : v)));
  }, [split]);

  const onDragEnd = useCallback(() => { dragRef.current = null; }, []);

  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h1 className="heading flex-1">WORKSPACE</h1>
        {layouts.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1">
            <button onClick={() => applyLayout(l)} className="btn-ghost text-xs">{l.name}</button>
            <button onClick={() => persist(layouts.filter((x) => x.id !== l.id))}
                    className="text-mut hover:text-red" title={`Delete layout "${l.name}"`}>
              <Trash2 size={11} />
            </button>
          </span>
        ))}
        <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
               placeholder="Layout name" className="input-bare !py-1 w-32 text-xs" />
        <button onClick={saveCurrent} className="btn-primary flex items-center gap-1.5 text-xs">
          <Save size={12} /> Save layout
        </button>
        <button onClick={addPane} disabled={panes.length >= 4}
                className="btn-ghost flex items-center gap-1.5 text-xs">
          <Plus size={12} /> Pane
        </button>
      </div>

      <div ref={containerRef} className="hidden md:grid gap-0 items-start"
           style={{ gridTemplateColumns: split.flatMap((f, i) => i < split.length - 1 ? [`${f}fr`, "10px"] : [`${f}fr`]).join(" ") }}>
        {panes.map((pane, i) => (
          <div key={i} className="contents">
            <div className="panel-2 p-3 min-w-0 h-full">
              <div className="flex items-center gap-2 mb-2">
                <select value={pane.widget}
                        onChange={(e) => setPane(i, { widget: e.target.value })}
                        className="input-bare !py-1 text-xs cursor-pointer w-32">
                  {WIDGETS.map((w) => <option key={w} value={w}>{WIDGET_LABELS[w]}</option>)}
                </select>
                {NEEDS_TICKER[pane.widget as WidgetKind] && (
                  <input defaultValue={pane.ticker ?? ""} key={`${i}:${pane.ticker}`}
                         onBlur={(e) => setPane(i, { ticker: e.target.value.trim().toUpperCase() })}
                         onKeyDown={(e) => { if (e.key === "Enter") setPane(i, { ticker: (e.target as HTMLInputElement).value.trim().toUpperCase() }); }}
                         className="input-bare !py-1 text-xs flex-1 min-w-0" placeholder="Ticker" />
                )}
                <button onClick={() => removePane(i)} className="text-mut hover:text-red" title="Close pane">
                  <X size={13} />
                </button>
              </div>
              <div className="overflow-auto max-h-[70vh]">
                <PaneView pane={pane} />
              </div>
            </div>
            {i < panes.length - 1 && (
              <div
                onPointerDown={(e) => onDragStart(i, e)}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                className="cursor-col-resize h-full min-h-[200px] flex items-center justify-center group"
                title="Drag to resize"
              >
                <div className="w-1 h-16 rounded bg-line group-hover:bg-amber/60" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Mobile: panes stack — resizing is a desktop affordance. */}
      <div className="md:hidden flex flex-col gap-4">
        {panes.map((pane, i) => (
          <div key={i} className="panel-2 p-3">
            <div className="label-xs mb-2">{WIDGET_LABELS[pane.widget as WidgetKind]} {pane.ticker ? `· ${pane.ticker}` : ""}</div>
            <PaneView pane={pane} />
          </div>
        ))}
      </div>
    </Shell>
  );
}
