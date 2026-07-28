"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, LayoutGrid, Plus, RotateCcw, Settings2 } from "lucide-react";

import { Shell } from "@/components/Shell";
import { MoversBoard } from "@/components/dashboard/MoversBoard";
import { SectionPicker } from "@/components/dashboard/SectionPicker";
import { StatusRail } from "@/components/dashboard/StatusRail";
import { TileSection } from "@/components/dashboard/TileSection";
import { WatchlistBoard } from "@/components/dashboard/WatchlistBoard";
import {
  addBoardSection, addCustomSection, addPresetSection, addSymbol, allSymbols,
  defaultLayout, loadLayout, moveSection, moveSymbol, removeSection,
  removeSymbol, renameSection, saveLayout, toggleCollapsed,
  type Layout, type SectionKind,
} from "@/lib/dashboardLayout";
import { guessRegion, instrument, region, REGIONS, type RegionId } from "@/lib/instruments";
import { quoteStore } from "@/lib/quoteStore";
import { useQuotes, useStreamStatus } from "@/lib/useQuote";

/**
 * The dashboard.
 *
 * Everything on it is user-arranged: sections can be added, renamed,
 * reordered, collapsed and deleted, individual instruments can be added or
 * pulled out of any board, and the whole arrangement is keyed to a home
 * region that reorders it around wherever the user actually sits.
 *
 * The layout lives in localStorage rather than on the server — it's a
 * per-device preference (a phone and a desk setup want different boards) and
 * it must render instantly on first paint with no round trip. loadLayout()
 * hardens the read, so a stale or corrupt blob degrades to the regional
 * default instead of a white screen.
 */

const REGION_KEY = "mb_home_region";

/** Count how many of the board's instruments actually have a price right now.
 *  Read off the store on an interval rather than by subscribing to every
 *  symbol: this is a status number, not a live cell, and subscribing would
 *  re-render the whole page on every tick. */
function usePricedCount(symbols: string[]): number {
  const [n, setN] = useState(0);
  const { status } = useStreamStatus();
  const key = symbols.join(",");
  useEffect(() => {
    const count = () => {
      const list = key ? key.split(",") : [];
      setN(list.filter((s) => quoteStore.getTick(s)?.ltp != null).length);
    };
    count();
    const id = setInterval(count, 2000);
    return () => clearInterval(id);
  }, [key, status]);
  return n;
}

function DashboardBody() {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);

  // Boot: saved layout, else a default built around the guessed region. The
  // guess is only ever a starting point — an explicit choice is persisted.
  useEffect(() => {
    const saved = loadLayout();
    if (saved) { setLayout(saved); return; }
    let r: RegionId;
    try { r = (localStorage.getItem(REGION_KEY) as RegionId) || guessRegion(); }
    catch { r = guessRegion(); }
    setLayout(defaultLayout(region(r).id));
  }, []);

  const update = useCallback((fn: (l: Layout) => Layout) => {
    setLayout((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      if (next !== prev) saveLayout(next);
      return next;
    });
  }, []);

  function switchRegion(id: RegionId) {
    if (!layout) return;
    const ok = confirm(
      `Switch home region to ${region(id).label}?\n\n`
      + `This rebuilds the dashboard with that region's default boards and `
      + `replaces your current arrangement. Watchlists are not affected.`);
    if (!ok) return;
    try { localStorage.setItem(REGION_KEY, id); } catch { /* non-fatal */ }
    const next = defaultLayout(id);
    saveLayout(next);
    setLayout(next);
  }

  function resetLayout() {
    if (!layout) return;
    if (!confirm("Reset this dashboard to the default boards for your region?")) return;
    const next = defaultLayout(layout.regionId);
    saveLayout(next);
    setLayout(next);
  }

  const symbols = useMemo(() => (layout ? allSymbols(layout) : []), [layout]);
  // ONE bulk subscription for the whole board; every tile reads its own cell.
  useQuotes(symbols);
  const priced = usePricedCount(symbols);
  const r = region(layout?.regionId);

  // Instruments known to have no free symbol are excluded from the coverage
  // ratio — counting them would permanently cap it below 100% and make a
  // healthy feed look broken.
  const priceable = useMemo(
    () => symbols.filter((s) => instrument(s).coverage !== "none").length, [symbols]);

  if (!layout) {
    return <div className="hud p-6 text-mut text-sm animate-pulse">Building your dashboard…</div>;
  }

  const tileSections = layout.sections.filter((s) => s.kind === "tiles");

  return (
    <>
      <StatusRail region={r} instrumentCount={priceable} pricedCount={priced} />

      {/* ── control bar ── */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <label className="flex items-center gap-1.5 text-[11px] text-mut">
          <span className="uppercase tracking-wider">Sitting in</span>
          <select value={layout.regionId}
                  onChange={(e) => switchRegion(e.target.value as RegionId)}
                  title="Reorders the whole dashboard around your home market and currency"
                  className="input-bare !py-1 text-xs">
            {REGIONS.map((x) => (
              <option key={x.id} value={x.id}>{x.flag} {x.label}</option>
            ))}
          </select>
        </label>

        <div className="flex-1" />

        <label className="flex items-center gap-1.5 text-[11px] text-mut cursor-pointer"
               title="Hide tiles the free feed can't price, instead of showing a row of dashes">
          <input type="checkbox" checked={!!layout.hideUnpriced}
                 onChange={() => update((l) => ({ ...l, hideUnpriced: !l.hideUnpriced }))}
                 className="accent-amber" />
          Hide unpriced
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-mut cursor-pointer"
               title="Tighter tiles — more instruments per screen">
          <input type="checkbox" checked={!!layout.dense}
                 onChange={() => update((l) => ({ ...l, dense: !l.dense }))}
                 className="accent-amber" />
          Dense
        </label>

        <button onClick={() => setPicking((v) => !v)}
                className="btn-ghost text-[11px] flex items-center gap-1.5">
          <Plus size={11} /> Add board
        </button>
        <button onClick={() => { setEditing((v) => !v); setPicking(false); }}
                className={`text-[11px] flex items-center gap-1.5 ${editing ? "btn-primary" : "btn-ghost"}`}>
          {editing ? <><Check size={11} /> Done</> : <><Settings2 size={11} /> Edit</>}
        </button>
        {editing && (
          <button onClick={resetLayout}
                  className="btn-ghost text-[11px] flex items-center gap-1.5"
                  title="Restore the default boards for your region">
            <RotateCcw size={11} /> Reset
          </button>
        )}
      </div>

      {picking && (
        <SectionPicker
          layout={layout}
          onAddPreset={(id) => update((l) => addPresetSection(l, id))}
          onAddCustom={(t) => { update((l) => addCustomSection(l, t)); setEditing(true); }}
          onAddBoard={(k: SectionKind, t) => update((l) => addBoardSection(l, k, t))}
          onClose={() => setPicking(false)}
        />
      )}

      {editing && (
        <div className="text-[11px] text-mut mb-4 flex items-center gap-2">
          <LayoutGrid size={11} className="text-amber" />
          Editing — hover a tile to move or remove it, double-click a section
          title to rename, and use the arrows to reorder boards. Saved to this
          browser automatically.
        </div>
      )}

      {/* ── market tiles ── */}
      {tileSections.map((s, tileIdx) => {
        return (
          <TileSection
            key={s.id}
            section={s}
            editing={editing}
            dense={!!layout.dense}
            hideUnpriced={!!layout.hideUnpriced}
            first={tileIdx === 0}
            last={tileIdx === tileSections.length - 1}
            onMoveSection={(d) => update((l) => moveSection(l, s.id, d))}
            onRemoveSection={() => update((l) => removeSection(l, s.id))}
            onToggleCollapsed={() => update((l) => toggleCollapsed(l, s.id))}
            onRename={(t) => update((l) => renameSection(l, s.id, t))}
            onAddSymbol={(sym) => update((l) => addSymbol(l, s.id, sym))}
            onRemoveSymbol={(sym) => update((l) => removeSymbol(l, s.id, sym))}
            onMoveSymbol={(sym, d) => update((l) => moveSymbol(l, s.id, sym, d))}
          />
        );
      })}

      {/* ── boards below the tiles, as requested: scroll down to reach them ── */}
      {layout.sections.filter((s) => s.kind !== "tiles").map((s) => (
        <div key={s.id} className="mt-7 pt-6 border-t border-line">
          {editing && (
            <div className="flex justify-end mb-1">
              <button onClick={() => update((l) => removeSection(l, s.id))}
                      className="text-[10px] uppercase tracking-wider text-mut hover:text-red">
                remove this board
              </button>
            </div>
          )}
          {s.kind === "movers" ? <MoversBoard /> : <WatchlistBoard />}
        </div>
      ))}

      <div className="text-[10.5px] text-mut mt-8 leading-relaxed">
        {priceable} instruments subscribed on one shared socket — tiles update
        independently, so nothing on this page re-renders wholesale on a tick.
        Tiles reading &ldquo;···&rdquo; are subscribed but haven&apos;t received a quote
        yet; the free data tier prices Indian listings direct from NSE and routes
        everything else through Twelve Data / yfinance, which are rate-limited
        and sometimes blocked from cloud hosts. Exchange clocks are computed
        from each venue&apos;s own timezone and handle daylight saving, but do
        <span className="text-txt"> not</span> know public holidays — an
        exchange shut for a national holiday will still read OPEN.
      </div>
    </>
  );
}

export default function DashboardPage() {
  return <Shell><DashboardBody /></Shell>;
}
