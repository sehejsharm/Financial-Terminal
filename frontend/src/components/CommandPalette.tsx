"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { FN_CODES, FN_DESCRIPTIONS, parseCommand } from "@/lib/commands";

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
  const [showHelp, setShowHelp] = useState(false);

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
            {/* Bloomberg-style command line: "RELIANCE.NS DES", "AAPL OMON",
                "RELIANCE TCS INFY CF" — parsed live and shown first so Enter
                executes the function jump. */}
            {(() => {
              const cmd = parseCommand(q);
              if (!cmd) return null;
              return (
                <Command.Group heading="Command" className="px-2 py-1 text-mut">
                  <Command.Item
                    value={`__cmd_${q}`}
                    onSelect={() => go(cmd.href)}
                    className="flex items-center gap-3 px-3 py-2 rounded cursor-pointer
                               data-[selected=true]:bg-panel data-[selected=true]:text-amber"
                  >
                    <span className="text-green text-[10px] uppercase tracking-wider">{cmd.code}</span>
                    <span className="text-txt">
                      <span className="text-amber">{cmd.tickers.join(" · ")}</span>
                      {" → "}{cmd.fnLabel}
                    </span>
                  </Command.Item>
                </Command.Group>
              );
            })()}

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

        {showHelp && (
          <div className="border-t border-line max-h-[40vh] overflow-y-auto px-4 py-3">
            <div className="label-xs mb-2">Command reference — type TICKER + CODE, e.g. “RELIANCE.NS DES” or “AAPL OMON”</div>
            <table className="w-full text-xs">
              <tbody>
                {Object.entries(FN_CODES).map(([code, label]) => (
                  <tr key={code} className="border-b border-line/40">
                    <td className="py-1.5 pr-3 text-green font-bold whitespace-nowrap align-top w-14">{code}</td>
                    <td className="py-1.5 pr-3 text-amber whitespace-nowrap align-top">{label}</td>
                    <td className="py-1.5 text-mut">{FN_DESCRIPTIONS[code] ?? ""}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1.5 pr-3 text-green font-bold align-top w-14">CF+</td>
                  <td className="py-1.5 pr-3 text-amber whitespace-nowrap align-top">Multi-compare</td>
                  <td className="py-1.5 text-mut">Several tickers then CF — “RELIANCE TCS INFY CF” → side-by-side comparables (bare NSE names get .NS automatically)</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="border-t border-line px-4 py-2 flex items-center gap-3 text-[10px] text-mut flex-wrap">
          <span><kbd className="px-1 border border-line2 rounded">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 border border-line2 rounded">↵</kbd> select</span>
          <span><kbd className="px-1 border border-line2 rounded">esc</kbd> close</span>
          <button onClick={() => setShowHelp((v) => !v)}
                  className="ml-auto text-amber hover:underline">
            {showHelp ? "hide commands" : "? all commands"}
          </button>
        </div>
      </div>
    </div>
  );
}
