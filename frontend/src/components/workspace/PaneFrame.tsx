"use client";

import { ChevronLeft, ChevronRight, Link2, Maximize2, Minimize2, X } from "lucide-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TickerInput } from "@/components/TickerInput";
import { PaneBody } from "@/components/workspace/PaneBody";
import { LINK_COLORS, LINK_GROUPS, type LinkGroup, type Pane } from "@/lib/workspace";
import { needsTicker, widget, widgetsByCategory, CATEGORY_LABELS } from "@/lib/workspaceWidgets";

/**
 * One pane: header chrome plus its widget.
 *
 * The link badge is the important control. Its colour matches the pane's top
 * border, so which panes are wired together is visible at a glance rather
 * than something you have to remember.
 *
 * Each pane is wrapped in its own error boundary — a workspace where one
 * failing widget blanks the other five would be worse than the single-pane
 * page it replaced.
 */
export function PaneFrame({
  pane, ticker, maximized, canMoveLeft, canMoveRight,
  onSetWidget, onSetLink, onSetTicker, onMove, onRemove, onToggleMax,
}: {
  pane: Pane;
  ticker: string;
  maximized: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onSetWidget: (w: string) => void;
  onSetLink: (g: LinkGroup) => void;
  onSetTicker: (t: string) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onToggleMax: () => void;
}) {
  const def = widget(pane.widget);
  const wantsTicker = needsTicker(pane.widget);
  const linkColor = LINK_COLORS[pane.link];

  return (
    <div data-testid="pane" data-widget={pane.widget} data-link={pane.link}
         className="hud flex flex-col min-w-0 h-full overflow-hidden"
         style={{ borderTop: `2px solid ${wantsTicker ? linkColor : "var(--c-line2)"}` }}>
      {/* ── header ── */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-line shrink-0">
        <select value={pane.widget} onChange={(e) => onSetWidget(e.target.value)}
                title={def?.blurb}
                className="input-bare !py-0.5 !px-1.5 text-[11px] cursor-pointer max-w-[150px]">
          {widgetsByCategory().map(([cat, list]) => (
            <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
              {list.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </optgroup>
          ))}
        </select>

        {wantsTicker ? (
          <>
            <div className="flex-1 min-w-0">
              <TickerInput
                value={ticker}
                onCommit={onSetTicker}
                placeholder="Ticker"
                className="input-bare !py-0.5 !px-1.5 text-[11px] w-full"
              />
            </div>
            <select value={pane.link} onChange={(e) => onSetLink(e.target.value as LinkGroup)}
                    title={pane.link === "none"
                      ? "Unlinked — this pane keeps its own ticker"
                      : `Linked to group ${pane.link} — retyping the ticker here moves every pane in group ${pane.link}`}
                    className="input-bare !py-0.5 !px-1 text-[10px] cursor-pointer w-[46px] shrink-0"
                    style={{ color: linkColor, borderColor: linkColor }}>
              {LINK_GROUPS.map((g) => (
                <option key={g} value={g}>{g === "none" ? "—" : g}</option>
              ))}
            </select>
          </>
        ) : (
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <span className="text-[10px] text-mut uppercase tracking-wider truncate">
              market-wide
            </span>
          </div>
        )}

        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={() => onMove(-1)} disabled={!canMoveLeft}
                  className="text-mut hover:text-amber disabled:opacity-25 disabled:hover:text-mut p-0.5"
                  title="Move pane left">
            <ChevronLeft size={12} />
          </button>
          <button onClick={() => onMove(1)} disabled={!canMoveRight}
                  className="text-mut hover:text-amber disabled:opacity-25 disabled:hover:text-mut p-0.5"
                  title="Move pane right">
            <ChevronRight size={12} />
          </button>
          <button onClick={onToggleMax} className="text-mut hover:text-amber p-0.5"
                  title={maximized ? "Restore pane (Esc)" : "Maximize pane"}>
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button onClick={onRemove} className="text-mut hover:text-red p-0.5" title="Close pane">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── body ── */}
      <div className="flex-1 min-h-0 overflow-auto p-2.5">
        {/* Keyed on widget+ticker so switching either fully remounts the
            child. Without it, a widget holding internal state for the old
            symbol would show it against the new one. */}
        <ErrorBoundary key={`${pane.widget}:${ticker}`}>
          <PaneBody widget={pane.widget} ticker={ticker} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

/** Legend for the link colours, shown once above the grid. */
export function LinkLegend({ groups, onSet }: {
  groups: Record<string, string>;
  onSet: (g: LinkGroup, t: string) => void;
}) {
  const active = (["A", "B", "C", "D"] as LinkGroup[]).filter((g) => groups[g]);
  if (!active.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-mut">
        <Link2 size={11} /> Linked groups
      </span>
      {active.map((g) => (
        <div key={g} className="flex items-center gap-1.5 px-2 py-1 rounded border"
             style={{ borderColor: LINK_COLORS[g] }}
             title={`Every pane on group ${g} shows this symbol. Change it here or in any ${g} pane.`}>
          <span className="text-[10px] font-bold" style={{ color: LINK_COLORS[g] }}>{g}</span>
          <TickerInput value={groups[g]} onCommit={(t) => onSet(g, t)}
                       placeholder="Ticker"
                       className="bg-transparent border-0 !p-0 text-[11px] num w-24 focus:outline-none text-txt" />
        </div>
      ))}
    </div>
  );
}
