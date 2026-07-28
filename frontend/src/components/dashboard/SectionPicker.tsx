"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

import { SECTION_PRESETS, ALL_INSTRUMENTS } from "@/lib/instruments";
import type { Layout, SectionKind } from "@/lib/dashboardLayout";

/** Add-a-board panel. Shows only what isn't already on the dashboard, plus
 *  the two singleton boards (movers / watchlists) if they were removed. */
export function SectionPicker({ layout, onAddPreset, onAddCustom, onAddBoard, onClose }: {
  layout: Layout;
  onAddPreset: (id: string) => void;
  onAddCustom: (title: string) => void;
  onAddBoard: (kind: SectionKind, title: string) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState("");
  const usedTitles = new Set(layout.sections.map((s) => s.title));
  const presets = SECTION_PRESETS.filter((p) => !usedTitles.has(p.title));
  const hasMovers = layout.sections.some((s) => s.kind === "movers");
  const hasWatch = layout.sections.some((s) => s.kind === "watchlists");

  // Catalogued instruments that no free feed can price — surfaced here so
  // their absence from the board reads as a decision, not an oversight.
  const unavailable = ALL_INSTRUMENTS.filter((i) => i.coverage === "none");

  return (
    <div className="hud p-4 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="heading">Add a board</span>
        <div className="flex-1" />
        <button onClick={onClose} className="text-mut hover:text-txt text-xs">close</button>
      </div>

      {presets.length > 0 ? (
        <div className="grid gap-2 mb-4"
             style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {presets.map((p) => (
            <button key={p.id} onClick={() => onAddPreset(p.id)}
                    className="text-left px-3 py-2 rounded border border-line2 bg-panel
                               hover:border-amber hover:bg-panel2 transition-colors group">
              <div className="flex items-center gap-1.5">
                <Plus size={11} className="text-mut group-hover:text-amber" />
                <span className="text-[12px] text-txt">{p.title}</span>
                <span className="num text-[10px] text-mut ml-auto">{p.symbols.length}</span>
              </div>
              <div className="text-[10.5px] text-mut mt-1 leading-snug">{p.blurb}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-mut text-xs mb-4">Every preset board is already on your dashboard.</div>
      )}

      <div className="flex flex-wrap items-end gap-2 pt-3 border-t border-line">
        <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="label-xs">Or build your own</span>
          <input value={custom} onChange={(e) => setCustom(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter" && custom.trim()) { onAddCustom(custom); setCustom(""); }
                 }}
                 placeholder="Board name (e.g. My energy names)"
                 className="input-bare !py-1.5 text-xs" />
        </label>
        <button onClick={() => { if (custom.trim()) { onAddCustom(custom); setCustom(""); } }}
                disabled={!custom.trim()}
                className="btn-primary text-xs disabled:opacity-40">
          Create board
        </button>

        {!hasMovers && (
          <button onClick={() => onAddBoard("movers", "Gainers & losers")}
                  className="btn-ghost text-xs">+ Gainers &amp; losers</button>
        )}
        {!hasWatch && (
          <button onClick={() => onAddBoard("watchlists", "Watchlists")}
                  className="btn-ghost text-xs">+ Watchlists</button>
        )}
      </div>

      {unavailable.length > 0 && (
        <div className="mt-4 pt-3 border-t border-line">
          <div className="label-xs mb-1.5 flex items-center gap-1.5">
            <X size={10} className="text-mut" /> Not offered — no free data
          </div>
          <div className="flex flex-col gap-1">
            {unavailable.map((i) => (
              <div key={i.sym} className="text-[10.5px] text-mut leading-snug">
                <span className="text-txt">{i.short}</span> — {i.note}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
