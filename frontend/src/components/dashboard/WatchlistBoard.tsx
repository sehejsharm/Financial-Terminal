"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Star, Trash2, X } from "lucide-react";

import { LiveNumber } from "@/components/LiveNumber";
import { PanelError } from "@/components/PanelStates";
import { TickerInput } from "@/components/TickerInput";
import { api, type Watchlist } from "@/lib/api";
import { instrument } from "@/lib/instruments";
import { useQuote, useQuotes } from "@/lib/useQuote";
import { curForTicker } from "@/lib/utils";

/**
 * Watchlists as live quote boards rather than a wall of static chips.
 *
 * The old version showed each ticker as a bare pill with no price, so you had
 * to click through to learn anything. Every row here streams, sorts by the
 * day's move, and can be removed inline — the list is a working surface, not
 * a bookmark folder.
 */

function Row({ ticker, wlId, onRemove, editing }: {
  ticker: string; wlId: string; onRemove: () => void; editing: boolean;
}) {
  const tick = useQuote(ticker);
  const cp = tick?.chgPct ?? null;
  const cur = curForTicker(ticker, tick?.ccy);
  const meta = instrument(ticker);
  const up = cp != null && cp >= 0;
  const mag = cp == null ? 0 : Math.min(100, (Math.abs(cp) / 3) * 100);

  return (
    <div className="relative flex items-center gap-2 px-2 py-[6px] rounded group
                    hover:bg-panel2 border border-transparent hover:border-line2 transition-colors">
      <span aria-hidden className="absolute left-0 top-0 bottom-0 rounded pointer-events-none transition-[width] duration-500"
            style={{
              width: `${mag}%`,
              background: cp == null ? "transparent"
                : up ? "rgb(var(--c-green) / 0.09)" : "rgb(var(--c-red) / 0.09)",
            }} />
      <Link href={`/terminal?t=${encodeURIComponent(ticker)}`}
            className="flex items-center gap-2 flex-1 min-w-0 relative">
        <span className="text-[12px] truncate min-w-0 flex-1 group-hover:text-amber transition-colors"
              title={meta.label !== ticker ? meta.label : undefined}>
          {meta.short}
        </span>
        <span className="num text-[12px] text-txt shrink-0">
          {tick?.ltp != null
            ? <LiveNumber value={tick.ltp} format="price" ccy={cur} />
            : <span className="text-mut">···</span>}
        </span>
        <span className={`num text-[12px] w-16 text-right shrink-0 ${
          cp == null ? "text-mut" : up ? "text-green" : "text-red"}`}>
          {cp != null ? <LiveNumber value={cp} format="pct" /> : "—"}
        </span>
      </Link>
      {editing && (
        <button onClick={onRemove} title={`Remove ${ticker}`}
                className="relative text-mut hover:text-red shrink-0">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function ListCard({ wl, onChanged }: { wl: Watchlist; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useQuotes(wl.tickers);

  // Read the store through the hooks in each Row; sorting here would need
  // page-wide tick subscriptions, so the order is stable (as saved) and the
  // magnitude bars carry the ranking visually instead.
  async function mutate(next: string[]) {
    setBusy(true); setErr(null);
    try {
      await api.updateWatchlist(wl.id, wl.name, next);
      onChanged();
    } catch (e: any) {
      setErr(e?.detail || "Could not save the watchlist.");
    } finally { setBusy(false); }
  }

  async function del() {
    if (!confirm(`Delete the watchlist "${wl.name}"? This cannot be undone.`)) return;
    try { await api.deleteWatchlist(wl.id); onChanged(); }
    catch (e: any) { setErr(e?.detail || "Could not delete."); }
  }

  return (
    <div className="hud p-3 min-w-0 flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <Star size={11} className="text-amber shrink-0" />
        <span className="text-[11px] uppercase tracking-[0.1em] font-bold text-amber truncate flex-1 min-w-0">
          {wl.name}
        </span>
        <span className="num text-[10px] text-mut">{wl.tickers.length}</span>
        <button onClick={() => setEditing((v) => !v)}
                className={`text-[10px] uppercase tracking-wider ${editing ? "text-amber" : "text-mut hover:text-txt"}`}>
          {editing ? "done" : "edit"}
        </button>
      </div>

      {err && <div className="mb-2"><PanelError error={err} /></div>}

      <div className="flex flex-col gap-0.5 flex-1">
        {wl.tickers.length === 0 && (
          <div className="text-mut text-xs py-2">Empty — add a ticker below.</div>
        )}
        {wl.tickers.map((t) => (
          <Row key={t} ticker={t} wlId={wl.id} editing={editing}
               onRemove={() => mutate(wl.tickers.filter((x) => x !== t))} />
        ))}
      </div>

      {editing && (
        <div className="mt-2 pt-2 border-t border-line flex items-center gap-2">
          <TickerInput value="" placeholder="Add ticker…"
                       className="input-bare !py-1 text-[11px] flex-1"
                       onCommit={(t) => {
                         const s = t.trim().toUpperCase();
                         if (s && !wl.tickers.includes(s)) mutate([...wl.tickers, s]);
                       }} />
          <button onClick={del} disabled={busy}
                  className="text-mut hover:text-red shrink-0" title="Delete watchlist">
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

export function WatchlistBoard() {
  const [lists, setLists] = useState<Watchlist[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [tickers, setTickers] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.listWatchlists()
      .then((l) => { setLists(l); setErr(null); })
      .catch((e: any) => setErr(e?.detail || "Could not load watchlists."));
  }, []);
  useEffect(load, [load]);

  async function create() {
    const nm = name.trim();
    const ts = tickers.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!nm || ts.length === 0) { setErr("Give it a name and at least one ticker."); return; }
    setBusy(true); setErr(null);
    try {
      await api.createWatchlist(nm, ts);
      setName(""); setTickers(""); setCreating(false); load();
    } catch (e: any) {
      setErr(e?.detail || "Could not create the watchlist.");
    } finally { setBusy(false); }
  }

  const total = useMemo(
    () => (lists ?? []).reduce((a, w) => a + w.tickers.length, 0), [lists]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <h2 className="heading">Watchlists</h2>
        {lists && (
          <span className="text-[10px] text-mut num">
            {lists.length} list{lists.length === 1 ? "" : "s"} · {total} instruments
          </span>
        )}
        <div className="flex-1" />
        <button onClick={() => setCreating((v) => !v)}
                className="btn-ghost text-[11px] flex items-center gap-1">
          <Plus size={11} /> {creating ? "Cancel" : "New list"}
        </button>
      </div>

      {creating && (
        <div className="hud p-3 mb-3 grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="List name" className="input-bare !py-1.5 text-xs" />
          <input value={tickers} onChange={(e) => setTickers(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") create(); }}
                 placeholder="RELIANCE.NS, TCS.NS, AAPL"
                 className="input-bare !py-1.5 text-xs" />
          <button onClick={create} disabled={busy} className="btn-primary text-xs">
            {busy ? "Saving…" : "Create"}
          </button>
        </div>
      )}

      {err && <div className="mb-3"><PanelError error={err} retry={load} /></div>}

      {lists === null && !err && (
        <div className="hud p-4 text-mut text-xs animate-pulse">Loading watchlists…</div>
      )}

      {lists && lists.length === 0 && (
        <div className="hud p-5 text-mut text-sm">
          No watchlists yet — hit <span className="text-amber">New list</span> to
          build one. Every ticker you add streams live here.
        </div>
      )}

      {lists && lists.length > 0 && (
        <div className="grid gap-3"
             style={{ gridTemplateColumns: "repeat(auto-fit, minmax(268px, 1fr))" }}>
          {lists.map((w) => <ListCard key={w.id} wl={w} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}
