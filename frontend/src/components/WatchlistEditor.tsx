"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { TickerInput } from "@/components/TickerInput";
import { api, type Watchlist } from "@/lib/api";

/** Create / list / delete watchlists. Writes go straight to the backend store. */
export function WatchlistEditor() {
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [name, setName] = useState("");
  const [tickers, setTickers] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    api.listWatchlists().then(setLists).catch(() => setLists([]));
  }
  useEffect(refresh, []);

  async function create() {
    const nm = name.trim();
    const ts = tickers.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!nm || ts.length === 0) { setErr("Name and at least one ticker required."); return; }
    setBusy(true); setErr(null);
    try {
      await api.createWatchlist(nm, ts);
      setName(""); setTickers(""); refresh();
    } catch (e: any) {
      setErr(e?.detail || "Could not create watchlist.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await api.deleteWatchlist(id).catch(() => {});
    refresh();
  }

  return (
    <div>
      <div className="panel-2 p-4 mb-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Watchlist name" className="input-bare" />
          <input value={tickers} onChange={(e) => setTickers(e.target.value)} placeholder="Tickers (RELIANCE.NS, TCS.NS, AAPL)" className="input-bare" />
          <TickerInput value="" onCommit={(t) => setTickers((prev) => (prev.trim() ? `${prev.trim().replace(/,\s*$/, "")}, ${t}` : t))}
                       placeholder="Search companies to add…" className="input-bare text-xs w-full" />
          <button onClick={create} disabled={busy} className="btn-primary">
            <Plus size={14} /> {busy ? "Saving…" : "Create"}
          </button>
        </div>
        {err && <div className="text-red text-xs mt-2">{err}</div>}
      </div>

      {lists.length === 0 ? (
        <div className="panel-2 p-6 text-mut text-sm">No watchlists yet — create one above.</div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {lists.map((w) => (
            <div key={w.id} className="panel-2 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-amber font-bold uppercase tracking-wider text-sm truncate">{w.name}</div>
                <button onClick={() => remove(w.id)} className="text-mut hover:text-red" title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {w.tickers.map((t) => (
                  <Link key={t} href={`/terminal?t=${encodeURIComponent(t)}`}
                        className="px-2 py-1 text-[11px] border border-line rounded hover:border-amber hover:text-amber transition-colors">
                    {t}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
