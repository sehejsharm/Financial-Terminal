"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Plus, Trash2 } from "lucide-react";

import { TickerInput } from "@/components/TickerInput";
import { TickerTile } from "@/components/dashboard/TickerTile";
import { instrument } from "@/lib/instruments";
import { quoteStore } from "@/lib/quoteStore";
import type { Section } from "@/lib/dashboardLayout";

/**
 * A board of instrument tiles, with its edit affordances.
 *
 * The edit controls live behind the page-level edit toggle rather than
 * appearing on hover all the time — a dashboard you might accidentally
 * rearrange while reading it isn't a dashboard you trust.
 */
export function TileSection({
  section, editing, dense, hideUnpriced, first, last,
  onMoveSection, onRemoveSection, onToggleCollapsed, onRename,
  onAddSymbol, onRemoveSymbol, onMoveSymbol,
}: {
  section: Section;
  editing: boolean;
  dense: boolean;
  hideUnpriced: boolean;
  first: boolean;
  last: boolean;
  onMoveSection: (dir: -1 | 1) => void;
  onRemoveSection: () => void;
  onToggleCollapsed: () => void;
  onRename: (title: string) => void;
  onAddSymbol: (sym: string) => void;
  onRemoveSymbol: (sym: string) => void;
  onMoveSymbol: (sym: string, dir: -1 | 1) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(section.title);

  // "Hide unpriced" reads the store directly rather than subscribing: it's a
  // layout decision that only needs to be right at render time, and
  // subscribing here would re-render the whole section on every tick — the
  // exact thing per-tile subscriptions exist to avoid.
  const visible = hideUnpriced
    ? section.symbols.filter((s) => {
        if (instrument(s).coverage === "none") return false;
        return quoteStore.getTick(s)?.ltp != null;
      })
    : section.symbols;

  const hiddenCount = section.symbols.length - visible.length;

  function commitRename() {
    setRenaming(false);
    if (draft.trim() && draft !== section.title) onRename(draft);
  }

  return (
    <section className="mb-5">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <button onClick={onToggleCollapsed}
                className="text-mut hover:text-amber shrink-0"
                title={section.collapsed ? "Expand" : "Collapse"}>
          {section.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>

        {renaming ? (
          <input autoFocus value={draft}
                 onChange={(e) => setDraft(e.target.value)}
                 onBlur={commitRename}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") commitRename();
                   if (e.key === "Escape") { setDraft(section.title); setRenaming(false); }
                 }}
                 className="input-bare !py-0.5 text-sm w-56" />
        ) : (
          <h2 className={`heading ${editing ? "cursor-text" : ""}`}
              onDoubleClick={() => editing && (setDraft(section.title), setRenaming(true))}
              title={editing ? "Double-click to rename" : undefined}>
            {section.title}
          </h2>
        )}

        <span className="text-[10px] text-mut num">
          {visible.length}{hiddenCount > 0 && <span title={`${hiddenCount} unpriced tile(s) hidden`}> · {hiddenCount} hidden</span>}
        </span>

        <div className="flex-1" />

        {editing && (
          <div className="flex items-center gap-1">
            <button onClick={() => onMoveSection(-1)} disabled={first}
                    className="p-1 rounded border border-line2 text-mut hover:text-amber disabled:opacity-30 disabled:hover:text-mut"
                    title="Move section up">
              <ChevronUp size={12} />
            </button>
            <button onClick={() => onMoveSection(1)} disabled={last}
                    className="p-1 rounded border border-line2 text-mut hover:text-amber disabled:opacity-30 disabled:hover:text-mut"
                    title="Move section down">
              <ChevronDown size={12} />
            </button>
            <button onClick={onRemoveSection}
                    className="p-1 rounded border border-line2 text-mut hover:text-red"
                    title="Remove this section">
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>

      {!section.collapsed && (
        <>
          <div className="grid gap-2"
               style={{
                 gridTemplateColumns: `repeat(auto-fit, minmax(${dense ? 132 : 158}px, 1fr))`,
               }}>
            {visible.map((s) => (
              <TickerTile key={s} sym={s} dense={dense} editing={editing}
                          onRemove={() => onRemoveSymbol(s)}
                          onMove={(d) => onMoveSymbol(s, d)} />
            ))}

            {editing && (
              <div className="hud flex flex-col justify-center gap-1 px-2.5 py-2 border-dashed">
                <span className="label-xs flex items-center gap-1"><Plus size={10} /> Add</span>
                <TickerInput value="" onCommit={onAddSymbol}
                             placeholder="Symbol…"
                             className="input-bare !py-0.5 !px-1.5 text-[11px] w-full" />
              </div>
            )}
          </div>

          {visible.length === 0 && !editing && (
            <div className="hud px-3 py-4 text-mut text-xs">
              {hiddenCount > 0
                ? `All ${hiddenCount} instruments here are currently unpriced by the free feed — turn off "hide unpriced" in Edit to see them.`
                : "No instruments in this section."}
            </div>
          )}
        </>
      )}
    </section>
  );
}
