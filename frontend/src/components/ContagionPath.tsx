"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Route } from "lucide-react";

import { PanelError } from "@/components/PanelStates";
import { api, type ContagionPath as PathResult } from "@/lib/api";

/**
 * Contagion path finder — "degrees of separation" for supply chains.
 *
 * Finds the shortest connecting route between ANY two companies through the
 * aggregate of every value-chain map ever generated, so two names that never
 * appear in the same map still connect via intermediaries.
 *
 * Reach is bounded by what has actually been mapped, and the UI says so:
 * this is a graph assembled from AI-generated maps, and a path is only as
 * trustworthy as its weakest hop — so every hop names the map it came from.
 */
export function ContagionPathFinder({ seed }: { seed?: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(seed ?? "");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<PathResult | null>(null);
  const [stats, setStats] = useState<{ companies: number; connections: number } | null>(null);

  useEffect(() => { if (seed) setFrom(seed); }, [seed]);

  useEffect(() => {
    if (!open || stats) return;
    api.vcGraphStats().then(setStats).catch(() => setStats(null));
  }, [open, stats]);

  async function run() {
    if (!from.trim() || !to.trim()) return;
    setBusy(true); setErr(null); setRes(null);
    try {
      setRes(await api.vcPath(from.trim(), to.trim()));
    } catch (e: any) {
      setErr(e?.detail || "Path search failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
              className="btn-ghost text-xs flex items-center gap-1.5"
              title="Find the shortest connection between any two companies across every map generated so far">
        <Route size={12} /> Contagion path
      </button>
    );
  }

  return (
    <div className="panel-2 p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <Route size={13} className="text-amber" />
        <span className="heading">Contagion path</span>
        <div className="flex-1" />
        {stats && (
          <span className="text-[10px] text-mut"
                title="The finder can only route through companies that have actually been mapped. Open more value chains to widen it.">
            graph: {stats.companies} companies · {stats.connections} links
          </span>
        )}
        <button onClick={() => setOpen(false)} className="text-mut hover:text-txt text-xs">close</button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 flex-1 min-w-[150px]">
          <span className="label-xs">From</span>
          <input value={from} onChange={(e) => setFrom(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") run(); }}
                 placeholder="Nvidia" className="input-bare !py-1 text-xs" />
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-[150px]">
          <span className="label-xs">To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") run(); }}
                 placeholder="Reliance Industries" className="input-bare !py-1 text-xs" />
        </label>
        <button onClick={run} disabled={busy || !from.trim() || !to.trim()}
                className="btn-primary text-xs disabled:opacity-50">
          {busy ? "Searching…" : "Find path"}
        </button>
      </div>

      {err && <div className="mt-2"><PanelError error={err} retry={run} /></div>}

      {res && !res.found && (
        <div className="mt-2 text-xs text-mut">
          {res.note || "No connection found in the maps generated so far."}{" "}
          Open more companies&apos; value chains to widen the graph — the finder can
          only route through relationships that have actually been mapped.
        </div>
      )}

      {res?.found && (
        <div className="mt-3">
          <div className="text-[11px] text-mut mb-1.5">
            {res.degrees === 0
              ? "Same company."
              : <>{res.degrees} degree{res.degrees === 1 ? "" : "s"} of separation</>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {res.nodes?.map((n, i) => (
              <span key={`${n}-${i}`} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span className="flex flex-col items-center">
                    <ArrowRight size={12} className="text-mut" />
                    <span className="text-[8.5px] uppercase tracking-wider text-mut">
                      {res.hops[i - 1]?.role}
                    </span>
                  </span>
                )}
                <span className={`px-2 py-1 rounded border text-xs ${
                  i === 0 || i === (res.nodes!.length - 1)
                    ? "border-amber/60 text-amber bg-amber/10"
                    : "border-line2 text-txt"}`}>
                  {n}
                </span>
              </span>
            ))}
          </div>
          <div className="text-[10px] text-mut mt-2">
            Hops sourced from the maps for{" "}
            {[...new Set(res.hops.map((h) => h.via_ticker).filter(Boolean))].join(", ") || "—"}.
            Every link is AI-generated, so this route is only as reliable as its
            weakest hop — verify before trading on it.
          </div>
        </div>
      )}
    </div>
  );
}
