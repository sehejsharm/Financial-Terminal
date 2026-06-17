"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";

type SearchHit = { symbol: string; name: string; exchange?: string };

/**
 * Cmd/Ctrl+K command palette — ticker search + page jump.
 *
 * Inspired by Bloomberg's <GO> bar: type a ticker, hit enter, you're in
 * the Terminal page for it. Also navigates pages by name.
 */
export function CommandPalette({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  // Debounce ticker search via the API.
  useEffect(() => {
    if (q.length < 2) { setHits([]); return; }
    const id = setTimeout(() => {
      api.search(q).then(setHits).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(id);
  }, [q]);

  function go(path: string) { onOpenChange(false); setQ(""); router.push(path); }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] bg-black/60 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-[640px] max-w-[92vw] panel-2 shadow-panel rounded-md overflow-hidden">
        <Command label="Command palette" className="text-sm">
          <Command.Input
            value={q}
            onValueChange={setQ}
            autoFocus
            placeholder="Type a ticker (RELIANCE.NS, AAPL) or page (Terminal, Screeners)…"
            className="w-full bg-transparent border-0 border-b border-line px-4 py-3.5 text-txt placeholder:text-mut/70 focus:outline-none"
          />
          <Command.List className="max-h-[60vh] overflow-y-auto py-1">
            {/* Synthetic "open raw query" row — cmdk's own keyboard handler
                selects it on Enter, which fixes the earlier bug where the
                onKeyDown on Input was swallowed when hits=[]. Always shown so
                Enter always navigates somewhere. */}
            {q.trim().length > 0 && (
              <Command.Group heading="Jump" className="px-2 py-1 text-mut">
                <Command.Item
                  value={`__open_${q}`}
                  onSelect={() => go(`/terminal?t=${encodeURIComponent(q.trim().toUpperCase())}`)}
                  className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer
                             data-[selected=true]:bg-panel data-[selected=true]:text-amber"
                >
                  <span className="text-mut text-[10px] uppercase tracking-wider">GO</span>
                  <span className="text-txt">Open <span className="text-amber">{q.trim().toUpperCase()}</span> in Terminal</span>
                </Command.Item>
              </Command.Group>
            )}
            <Command.Empty className="px-4 py-3 text-mut text-xs">
              Keep typing — or press Enter to open “{q.toUpperCase()}” directly.
            </Command.Empty>

            <Command.Group heading="Pages" className="px-2 py-1 text-mut">
              {[
                { label: "Dashboard", path: "/" },
                { label: "Terminal", path: "/terminal" },
                { label: "Screeners", path: "/screeners" },
              ].map((p) => (
                <Command.Item
                  key={p.path}
                  onSelect={() => go(p.path)}
                  className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer
                             data-[selected=true]:bg-panel data-[selected=true]:text-amber"
                >
                  <span className="text-mut text-[10px] uppercase tracking-wider">GO</span>
                  <span className="text-txt">{p.label}</span>
                </Command.Item>
              ))}
            </Command.Group>

            {hits.length > 0 && (
              <Command.Group heading="Securities" className="px-2 py-1 text-mut">
                {hits.map((h) => (
                  <Command.Item
                    key={h.symbol}
                    onSelect={() => go(`/terminal?t=${encodeURIComponent(h.symbol)}`)}
                    className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer
                               data-[selected=true]:bg-panel data-[selected=true]:text-amber"
                  >
                    <span className="text-amber font-bold tracking-wider w-24 truncate">{h.symbol}</span>
                    <span className="flex-1 truncate text-txt">{h.name}</span>
                    {h.exchange && <span className="text-mut text-xs">{h.exchange}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>

        <div className="border-t border-line px-4 py-2 flex items-center gap-3 text-[10px] text-mut">
          <span><kbd className="px-1 border border-line2 rounded">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 border border-line2 rounded">↵</kbd> select</span>
          <span><kbd className="px-1 border border-line2 rounded">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
