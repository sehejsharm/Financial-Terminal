"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronUp, Grid2x2, LayoutGrid, Plus, RotateCcw, Rows3,
  Save, Trash2, X,
} from "lucide-react";

import { Shell } from "@/components/Shell";
import { LinkLegend, PaneFrame } from "@/components/workspace/PaneFrame";
import { api, type WorkspaceLayout } from "@/lib/api";
import { useQuotes } from "@/lib/useQuote";
import {
  activeTickers, addPane, addRow, DEFAULT_TICKER, emptyWorkspace, evenOut,
  makePane, makeRow,
  MAX_PANES, MAX_PANES_PER_ROW, MAX_ROWS, movePane, moveRow, newId, normalize,
  paneCount, removePane, removeRow, resizeColumn, resizeRow, setGroupTicker,
  setPane, setPaneLink, setTickerFrom, tickerFor, WS_VERSION,
  type LinkGroup, type Workspace,
} from "@/lib/workspace";
import {
  DESK_PRESETS, WIDGET_IDS, needsTicker, preset, widget,
} from "@/lib/workspaceWidgets";

/**
 * The workspace: a tiling grid of live panes with Bloomberg-style ticker
 * linking.
 *
 * Layouts are saved on the SERVER (they're a real artefact of how you work,
 * and should follow you between machines), while the id of the one you had
 * open last is remembered locally — that's a per-device thing.
 */

const ACTIVE_KEY = "mb_ws_active";

/** A row is at least as tall as its most demanding widget wants to be — a
 *  price chart squeezed into 140px is not a chart. Capped so one greedy
 *  widget can't push every other row off the screen. */
function rowMinHeight(row: { panes: { widget: string }[] }): number {
  const want = row.panes.map((p) => widget(p.widget)?.minHeight ?? 240);
  return Math.min(400, Math.max(200, ...want));
}

// ── divider ───────────────────────────────────────────────────────────────

/** Drag handle between two panes or two rows. Reports movement as a fraction
 *  of the container so the pure resize helpers stay unit-agnostic. */
function Divider({ vertical, onDrag }: {
  vertical?: boolean; onDrag: (frac: number) => void;
}) {
  const last = useRef<number | null>(null);

  function down(e: React.PointerEvent) {
    last.current = vertical ? e.clientY : e.clientX;
    // Capture on the element itself so the pointer can leave it mid-drag
    // without the gesture dying.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    if (last.current == null) return;
    const el = (e.currentTarget as HTMLElement).parentElement;
    if (!el) return;
    const span = vertical ? el.clientHeight : el.clientWidth;
    if (!span) return;
    const now = vertical ? e.clientY : e.clientX;
    onDrag((now - last.current) / span);
    last.current = now;
  }
  function up(e: React.PointerEvent) {
    last.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); }
    catch { /* already released */ }
  }

  return (
    <div onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
         title="Drag to resize"
         className={`group flex items-center justify-center shrink-0 touch-none
                     ${vertical ? "h-2 cursor-row-resize" : "w-2 cursor-col-resize"}`}>
      <div className={`rounded bg-line group-hover:bg-amber/70 transition-colors
                       ${vertical ? "h-[3px] w-14" : "w-[3px] h-14"}`} />
    </div>
  );
}

// ── layout picker ─────────────────────────────────────────────────────────

function PresetPicker({ onPick, onClose }: {
  onPick: (id: string) => void; onClose: () => void;
}) {
  return (
    <div className="hud p-3 mb-3">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="heading">Start from a desk</span>
        <div className="flex-1" />
        <button onClick={onClose} className="text-mut hover:text-txt text-xs">close</button>
      </div>
      <div className="grid gap-2"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
        {DESK_PRESETS.map((p) => (
          <button key={p.id} onClick={() => onPick(p.id)}
                  className="text-left px-3 py-2 rounded border border-line2 bg-panel
                             hover:border-amber hover:bg-panel2 transition-colors group">
            <div className="flex items-center gap-1.5">
              <LayoutGrid size={11} className="text-mut group-hover:text-amber" />
              <span className="text-[12px] text-txt">{p.name}</span>
              <span className="num text-[10px] text-mut ml-auto">
                {p.rows.reduce((a, r) => a + r.length, 0)} panes
              </span>
            </div>
            <div className="text-[10.5px] text-mut mt-1 leading-snug">{p.blurb}</div>
          </button>
        ))}
      </div>
      <div className="text-[10.5px] text-mut mt-3">
        Picking a desk replaces the current arrangement. Save the one you have
        first if you want it back.
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────

function WorkspaceBody() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [layouts, setLayouts] = useState<WorkspaceLayout[]>([]);
  const [saveName, setSaveName] = useState("");
  const [picking, setPicking] = useState(false);
  const [maxPane, setMaxPane] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Epoch ms of the last confirmed save — drives the "saved" tick. */
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Boot: restore saved layouts, reopening whichever was last active here.
  useEffect(() => {
    let alive = true;
    api.workspaces()
      .then((res) => {
        if (!alive) return;
        const list = res.layouts ?? [];
        setLayouts(list);
        let wantId: string | null = null;
        try { wantId = localStorage.getItem(ACTIVE_KEY); } catch { /* ignore */ }
        const chosen = list.find((l) => l.id === wantId)
          ?? list.find((l) => l.id === res.active_id)
          ?? list[0];
        const restored = chosen ? normalize(chosen, WIDGET_IDS) : null;
        setWs(restored ?? fromPreset("research"));
      })
      .catch(() => { if (alive) setWs(fromPreset("research")); });
    return () => { alive = false; };
  }, []);

  const update = useCallback((fn: (w: Workspace) => Workspace) => {
    setWs((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      if (next !== prev) setDirty(true);
      return next;
    });
  }, []);

  function fromPreset(id: string): Workspace {
    const p = preset(id);
    const base = emptyWorkspace(p?.name ?? "Workspace");
    if (!p) return base;
    const rows = p.rows.map((row) =>
      makeRow(row.map(([wid, link]) => makePane(wid, link as LinkGroup))));
    // Seed every group the preset actually uses. Without this, a two-symbol
    // desk's second group stays empty: its panes fall back to the default
    // ticker but the group never appears in the legend, so there's nowhere
    // obvious to type the second symbol.
    const groups = { ...base.groups };
    for (const row of p.rows) {
      for (const [, link] of row) {
        if (link !== "none" && !groups[link]) groups[link] = DEFAULT_TICKER;
      }
    }
    return { ...base, id: newId("ws"), name: p.name, rows, groups };
  }

  function applyPreset(id: string) {
    setWs(fromPreset(id));
    setPicking(false);
    setMaxPane(null);
    setDirty(true);
  }

  async function persist(next: WorkspaceLayout[], activeId?: string | null) {
    setLayouts(next);
    await api.saveWorkspaces(next, activeId ?? undefined);
  }

  /**
   * Save the current arrangement.
   *
   * Awaited, and `dirty` only clears once the SERVER has confirmed. The
   * earlier version cleared it optimistically, so a rejected save still read
   * as saved — and navigating straight after clicking could abort the
   * in-flight request with nothing on screen to say so.
   */
  async function saveCurrent() {
    if (!ws || saving) return;
    const name = saveName.trim() || ws.name || `Desk ${layouts.length + 1}`;
    // Saving under an existing name UPDATES it rather than creating a
    // near-duplicate the user then has to clean up.
    const existing = layouts.find((l) => l.name === name);
    const doc: WorkspaceLayout = {
      id: existing?.id ?? ws.id,
      name,
      version: WS_VERSION,
      rows: ws.rows.map((r) => ({
        id: r.id, height: r.height, split: r.split,
        panes: r.panes.map((p) => ({
          id: p.id, widget: p.widget, link: p.link,
          ...(p.ticker ? { ticker: p.ticker } : {}),
        })),
      })),
      groups: ws.groups,
    };
    const next = [...layouts.filter((l) => l.id !== doc.id), doc];

    setSaving(true); setErr(null);
    try {
      await persist(next, doc.id);
      setWs((w) => (w ? { ...w, id: doc.id, name } : w));
      setSaveName("");
      setDirty(false);
      setSavedAt(Date.now());
      try { localStorage.setItem(ACTIVE_KEY, doc.id); } catch { /* ignore */ }
    } catch (e: any) {
      setErr(e?.detail
        || "Could not save to the server — your arrangement is still on screen, but it is NOT stored.");
    } finally {
      setSaving(false);
    }
  }

  function openLayout(l: WorkspaceLayout) {
    const restored = normalize(l, WIDGET_IDS);
    if (!restored) {
      setErr(`"${l.name}" couldn't be restored — it may have been saved by a newer version.`);
      return;
    }
    setWs(restored);
    setMaxPane(null);
    setDirty(false);
    try { localStorage.setItem(ACTIVE_KEY, l.id); } catch { /* ignore */ }
  }

  function deleteLayout(l: WorkspaceLayout) {
    if (!confirm(`Delete the saved desk "${l.name}"? This cannot be undone.`)) return;
    persist(layouts.filter((x) => x.id !== l.id))
      .catch((e: any) => setErr(e?.detail || "Could not delete that desk on the server."));
  }

  // Esc leaves the maximized pane — the expected way out of a focus mode.
  useEffect(() => {
    if (!maxPane) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMaxPane(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maxPane]);

  const tickers = useMemo(() => (ws ? activeTickers(ws) : []), [ws]);
  // One bulk subscription for every symbol on the grid; each pane's own
  // useQuote reads its cell from the shared store.
  useQuotes(tickers);

  if (!ws) {
    return <div className="hud p-6 text-mut text-sm animate-pulse">Restoring your workspace…</div>;
  }

  const total = paneCount(ws);
  const maximized = maxPane ? ws.rows.flatMap((r) => r.panes).find((p) => p.id === maxPane) : null;

  const paneProps = (p: (typeof ws.rows)[number]["panes"][number], row: (typeof ws.rows)[number]) => {
    const i = row.panes.findIndex((x) => x.id === p.id);
    return {
      pane: p,
      ticker: tickerFor(ws, p),
      maximized: maxPane === p.id,
      canMoveLeft: i > 0,
      canMoveRight: i < row.panes.length - 1,
      onSetWidget: (w: string) => update((x) => setPane(x, p.id, { widget: w })),
      onSetLink: (g: LinkGroup) => update((x) => setPaneLink(x, p.id, g)),
      onSetTicker: (t: string) => update((x) => setTickerFrom(x, p.id, t)),
      onMove: (d: -1 | 1) => update((x) => movePane(x, p.id, d)),
      onRemove: () => { setMaxPane(null); update((x) => removePane(x, p.id)); },
      onToggleMax: () => setMaxPane((cur) => (cur === p.id ? null : p.id)),
    };
  };

  return (
    <>
      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="heading">WORKSPACE</h1>
        <span className="text-[10px] text-mut num">
          {total}/{MAX_PANES} panes · {ws.rows.length}/{MAX_ROWS} rows
        </span>
        {dirty && !saving && (
          <span className="text-[10px] uppercase tracking-wider text-amber"
                title="This arrangement has unsaved changes">
            unsaved
          </span>
        )}
        {!dirty && savedAt && (
          <span data-testid="ws-saved"
                className="text-[10px] uppercase tracking-wider text-green"
                title="Stored on your account">
            saved
          </span>
        )}

        <div className="flex-1" />

        {layouts.map((l) => (
          <span key={l.id} className="inline-flex items-center">
            <button onClick={() => openLayout(l)}
                    className={`text-[11px] px-2 py-1 rounded-l border border-line2
                                ${l.id === ws.id ? "bg-panel2 text-amber border-amber/50" : "text-txt hover:border-amber"}`}>
              {l.name}
            </button>
            <button onClick={() => deleteLayout(l)} title={`Delete "${l.name}"`}
                    className="px-1 py-1 rounded-r border border-l-0 border-line2 text-mut hover:text-red">
              <Trash2 size={10} />
            </button>
          </span>
        ))}

        <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") saveCurrent(); }}
               placeholder={ws.name} className="input-bare !py-1 w-28 text-[11px]" />
        <button onClick={saveCurrent} disabled={saving}
                className="btn-primary text-[11px] flex items-center gap-1.5 disabled:opacity-60">
          <Save size={11} /> {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setPicking((v) => !v)}
                className="btn-ghost text-[11px] flex items-center gap-1.5">
          <Grid2x2 size={11} /> Desks
        </button>
        <button onClick={() => update((x) => addRow(x))}
                disabled={ws.rows.length >= MAX_ROWS || total >= MAX_PANES}
                className="btn-ghost text-[11px] flex items-center gap-1.5 disabled:opacity-40">
          <Rows3 size={11} /> Add row
        </button>
        <button onClick={() => update(evenOut)}
                className="btn-ghost text-[11px] flex items-center gap-1.5"
                title="Reset every pane and row to equal size">
          <RotateCcw size={11} /> Even out
        </button>
        <div className="flex-1" />
        <LinkLegend groups={ws.groups}
                    onSet={(g, t) => update((x) => setGroupTicker(x, g, t))} />
      </div>

      {err && (
        <div className="hud p-3 mb-3 text-xs text-red flex items-center gap-3">
          <span className="flex-1">{err}</span>
          <button onClick={() => setErr(null)} className="text-mut hover:text-txt"><X size={12} /></button>
        </div>
      )}

      {picking && <PresetPicker onPick={applyPreset} onClose={() => setPicking(false)} />}

      {/* ── maximized pane ── */}
      {maximized ? (
        <div className="h-[calc(100vh-190px)] min-h-[420px]">
          <PaneFrame {...paneProps(maximized,
            ws.rows.find((r) => r.panes.some((p) => p.id === maximized.id))!)} />
        </div>
      ) : (
        <>
          {/* ── the grid (desktop) ──
              min-height, NOT a fixed height: the grid fills the viewport when
              the rows fit, but each row also carries a minimum derived from
              its tallest widget, so on a short screen the page scrolls
              instead of clipping the bottom row off the fold. */}
          <div className="hidden md:flex flex-col min-h-[calc(100vh-215px)]">
            {ws.rows.map((row, ri) => (
              // Fragment, NOT a display:contents div: the divider measures its
              // parentElement, and a contents box reports clientWidth/Height 0,
              // which silently killed every resize drag.
              <Fragment key={row.id}>
                <div className="flex min-h-0"
                     style={{ flex: `${row.height} 1 0%`, minHeight: rowMinHeight(row) }}>
                  {row.panes.map((p, pi) => (
                    <Fragment key={p.id}>
                      <div className="min-w-0 flex flex-col" style={{ flex: `${row.split[pi]} 1 0%` }}>
                        <PaneFrame {...paneProps(p, row)} />
                      </div>
                      {pi < row.panes.length - 1 && (
                        <Divider onDrag={(f) => update((x) => resizeColumn(x, row.id, pi, f))} />
                      )}
                    </Fragment>
                  ))}

                  {/* Per-row controls: a proper rail with real hit targets,
                      not four glyphs crushed into the gutter. */}
                  <div className="flex flex-col gap-0.5 justify-start pl-1.5 pt-1 w-7 shrink-0">
                    <button onClick={() => update((x) => addPane(x, row.id, "news"))}
                            disabled={row.panes.length >= MAX_PANES_PER_ROW || total >= MAX_PANES}
                            title="Add a pane to this row"
                            className="h-5 rounded border border-line2 flex items-center justify-center
                                       text-mut hover:text-amber hover:border-amber
                                       disabled:opacity-25 disabled:hover:text-mut disabled:hover:border-line2">
                      <Plus size={11} />
                    </button>
                    <button onClick={() => update((x) => moveRow(x, row.id, -1))}
                            disabled={ri === 0} title="Move row up"
                            className="h-5 rounded border border-line2 flex items-center justify-center
                                       text-mut hover:text-amber hover:border-amber
                                       disabled:opacity-25 disabled:hover:text-mut disabled:hover:border-line2">
                      <ChevronUp size={11} />
                    </button>
                    <button onClick={() => update((x) => moveRow(x, row.id, 1))}
                            disabled={ri === ws.rows.length - 1} title="Move row down"
                            className="h-5 rounded border border-line2 flex items-center justify-center
                                       text-mut hover:text-amber hover:border-amber
                                       disabled:opacity-25 disabled:hover:text-mut disabled:hover:border-line2">
                      <ChevronDown size={11} />
                    </button>
                    <button onClick={() => update((x) => removeRow(x, row.id))}
                            disabled={ws.rows.length <= 1} title="Remove this row"
                            className="h-5 rounded border border-line2 flex items-center justify-center
                                       text-mut hover:text-red hover:border-red
                                       disabled:opacity-25 disabled:hover:text-mut disabled:hover:border-line2">
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
                {ri < ws.rows.length - 1 && (
                  <Divider vertical onDrag={(f) => update((x) => resizeRow(x, ri, f))} />
                )}
              </Fragment>
            ))}
          </div>

          {/* ── mobile: panes stack, full controls kept ── */}
          <div className="md:hidden flex flex-col gap-3">
            {ws.rows.flatMap((row) => row.panes.map((p) => (
              <div key={p.id} style={{ minHeight: widget(p.widget)?.minHeight ?? 240 }}
                   className="flex flex-col">
                <PaneFrame {...paneProps(p, row)} />
              </div>
            )))}
          </div>
        </>
      )}

      <div className="text-[10.5px] text-mut mt-4 leading-relaxed">
        Panes sharing a link group share a symbol — retype the ticker in any
        one of them and the rest follow, so a chart, its news, its financials
        and its value chain all re-point in a single keystroke. Set a pane to
        <span className="text-txt"> —</span> to unlink it and pin it to its own
        symbol. Drag the bars between panes and rows to resize; maximize a pane
        with the expand icon and leave it with <kbd className="px-1 border border-line2 rounded">Esc</kbd>.
        Desks are saved to your account so they follow you between machines;
        which one you had open last is remembered per device.
        {tickers.length > 0 && (
          <> {tickers.length} symbol{tickers.length === 1 ? "" : "s"} subscribed on the
          shared socket.</>
        )}
      </div>
    </>
  );
}

export default function WorkspacePage() {
  return <Shell><WorkspaceBody /></Shell>;
}
