/** Workspace layout model: a tiling grid of panes with Bloomberg-style
 *  ticker linking.
 *
 *  THE MODEL
 *  A workspace is rows; each row is panes. Rows carry a height weight, panes
 *  carry a width weight, both as flex fractions — so a 2x2, a 3-over-1, or a
 *  single wide chart are all the same structure with different weights.
 *
 *  LINK GROUPS are the feature that makes a multi-pane workspace worth having.
 *  A pane bound to group A doesn't own a ticker; it reads the group's. Retype
 *  the ticker in any A pane and every A pane follows — chart, news, financials
 *  and value chain all re-point in one keystroke. Group "none" means the pane
 *  keeps its own ticker and ignores everyone else.
 *
 *  Everything here is pure so the whole interaction model is unit-testable
 *  without mounting React, and so persistence has one hardened entry point:
 *  normalize() must always return something renderable, because a workspace
 *  that white-screens on a stale saved layout is worse than one that quietly
 *  drops a pane it no longer understands.
 */

export type LinkGroup = "none" | "A" | "B" | "C" | "D";
export const LINK_GROUPS: LinkGroup[] = ["none", "A", "B", "C", "D"];

/** Colours match the pane border + badge so a glance shows what's wired to
 *  what. Amber is reserved for the app's own accent, so groups avoid it. */
export const LINK_COLORS: Record<LinkGroup, string> = {
  none: "var(--c-line2)",
  A: "#3b82f6",   // blue
  B: "#22c55e",   // green
  C: "#a855f7",   // violet
  D: "#f97316",   // orange
};

export type Pane = {
  id: string;
  widget: string;
  /** Only used when link === "none"; otherwise the group's ticker wins. */
  ticker?: string;
  link: LinkGroup;
};

export type Row = {
  id: string;
  panes: Pane[];
  /** Per-pane width weights, same length as panes. */
  split: number[];
  /** Row height weight. */
  height: number;
};

export type Workspace = {
  version: number;
  id: string;
  name: string;
  rows: Row[];
  /** Ticker per link group. */
  groups: Record<string, string>;
};

export const WS_VERSION = 2;
export const MAX_ROWS = 4;
export const MAX_PANES_PER_ROW = 4;
export const MAX_PANES = 12;
export const MIN_WEIGHT = 0.15;

let seq = 0;
export function newId(prefix = "p"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

export const DEFAULT_TICKER = "RELIANCE.NS";

// ── construction ──────────────────────────────────────────────────────────

export function makePane(widget: string, link: LinkGroup = "A", ticker?: string): Pane {
  return { id: newId(), widget, link, ...(ticker ? { ticker } : {}) };
}

export function makeRow(panes: Pane[], height = 1): Row {
  return { id: newId("r"), panes, split: panes.map(() => 1), height };
}

export function emptyWorkspace(name = "Workspace"): Workspace {
  return {
    version: WS_VERSION,
    id: newId("ws"),
    name,
    rows: [makeRow([makePane("chart"), makePane("news")])],
    groups: { A: DEFAULT_TICKER, B: "", C: "", D: "" },
  };
}

/** Total pane count across all rows. */
export function paneCount(ws: Workspace): number {
  return ws.rows.reduce((a, r) => a + r.panes.length, 0);
}

/** The ticker a pane should actually render, resolving its link group. */
export function tickerFor(ws: Workspace, pane: Pane): string {
  if (pane.link === "none") return (pane.ticker || DEFAULT_TICKER).toUpperCase();
  return (ws.groups[pane.link] || DEFAULT_TICKER).toUpperCase();
}

/** Every distinct ticker currently on screen — for one bulk subscription. */
export function activeTickers(ws: Workspace): string[] {
  const out = new Set<string>();
  for (const r of ws.rows) {
    for (const p of r.panes) out.add(tickerFor(ws, p));
  }
  return [...out];
}

export function findPane(ws: Workspace, paneId: string): { row: Row; pane: Pane } | null {
  for (const row of ws.rows) {
    const pane = row.panes.find((p) => p.id === paneId);
    if (pane) return { row, pane };
  }
  return null;
}

// ── pane operations (all pure, all return a new workspace) ────────────────

export function addPane(ws: Workspace, rowId: string, widget: string,
                        link: LinkGroup = "A"): Workspace {
  if (paneCount(ws) >= MAX_PANES) return ws;
  const row = ws.rows.find((r) => r.id === rowId);
  if (!row || row.panes.length >= MAX_PANES_PER_ROW) return ws;
  const pane = makePane(widget, link);
  return {
    ...ws,
    rows: ws.rows.map((r) => (r.id !== rowId ? r : {
      ...r, panes: [...r.panes, pane], split: [...r.split, 1],
    })),
  };
}

export function removePane(ws: Workspace, paneId: string): Workspace {
  // Never leave an empty workspace — the last pane is not removable.
  if (paneCount(ws) <= 1) return ws;
  const rows: Row[] = [];
  for (const r of ws.rows) {
    const i = r.panes.findIndex((p) => p.id === paneId);
    if (i < 0) { rows.push(r); continue; }
    const panes = r.panes.filter((_, j) => j !== i);
    const split = r.split.filter((_, j) => j !== i);
    // A row that loses its last pane disappears rather than leaving a gap.
    if (panes.length) rows.push({ ...r, panes, split });
  }
  return rows.length ? { ...ws, rows } : ws;
}

export function setPane(ws: Workspace, paneId: string, patch: Partial<Pane>): Workspace {
  return {
    ...ws,
    rows: ws.rows.map((r) => ({
      ...r,
      panes: r.panes.map((p) => (p.id === paneId ? { ...p, ...patch, id: p.id } : p)),
    })),
  };
}

/**
 * Set the ticker "from" a pane — the operation the ticker box performs.
 *
 * A linked pane writes to its GROUP, so every other pane in that group
 * follows; an unlinked pane writes only to itself. This one function is the
 * whole linking behaviour.
 */
export function setTickerFrom(ws: Workspace, paneId: string, raw: string): Workspace {
  const t = (raw || "").trim().toUpperCase();
  if (!t) return ws;
  const hit = findPane(ws, paneId);
  if (!hit) return ws;
  if (hit.pane.link === "none") return setPane(ws, paneId, { ticker: t });
  return { ...ws, groups: { ...ws.groups, [hit.pane.link]: t } };
}

export function setGroupTicker(ws: Workspace, group: LinkGroup, raw: string): Workspace {
  const t = (raw || "").trim().toUpperCase();
  if (!t || group === "none") return ws;
  return { ...ws, groups: { ...ws.groups, [group]: t } };
}

/**
 * Rebinding a pane's link group carries its CURRENT ticker across, so the
 * pane doesn't jump to some unrelated symbol the moment you link it.
 * Switching to "none" freezes whatever it was showing.
 */
export function setPaneLink(ws: Workspace, paneId: string, link: LinkGroup): Workspace {
  const hit = findPane(ws, paneId);
  if (!hit) return ws;
  const current = tickerFor(ws, hit.pane);
  if (link === "none") return setPane(ws, paneId, { link, ticker: current });
  const next = setPane(ws, paneId, { link });
  // Seed an empty group with this pane's ticker rather than defaulting it.
  return ws.groups[link]
    ? next
    : { ...next, groups: { ...next.groups, [link]: current } };
}

// ── row operations ────────────────────────────────────────────────────────

export function addRow(ws: Workspace, widget = "chart"): Workspace {
  if (ws.rows.length >= MAX_ROWS || paneCount(ws) >= MAX_PANES) return ws;
  return { ...ws, rows: [...ws.rows, makeRow([makePane(widget)])] };
}

export function removeRow(ws: Workspace, rowId: string): Workspace {
  if (ws.rows.length <= 1) return ws;
  const rows = ws.rows.filter((r) => r.id !== rowId);
  return rows.length === ws.rows.length ? ws : { ...ws, rows };
}

export function moveRow(ws: Workspace, rowId: string, dir: -1 | 1): Workspace {
  const i = ws.rows.findIndex((r) => r.id === rowId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ws.rows.length) return ws;
  const rows = [...ws.rows];
  [rows[i], rows[j]] = [rows[j], rows[i]];
  return { ...ws, rows };
}

/** Reorder a pane within its row.
 *
 *  Returns the SAME workspace object when nothing moved. That identity
 *  guarantee matters: these run from pointer handlers, and allocating a new
 *  object on every no-op would re-render the entire grid while the user drags
 *  against an end stop. */
export function movePane(ws: Workspace, paneId: string, dir: -1 | 1): Workspace {
  let moved = false;
  const rows = ws.rows.map((r) => {
    const i = r.panes.findIndex((p) => p.id === paneId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= r.panes.length) return r;
    const panes = [...r.panes];
    const split = [...r.split];
    [panes[i], panes[j]] = [panes[j], panes[i]];
    [split[i], split[j]] = [split[j], split[i]];
    moved = true;
    return { ...r, panes, split };
  });
  return moved ? { ...ws, rows } : ws;
}

/** Send a pane to another row (creating nothing — target must exist). */
export function movePaneToRow(ws: Workspace, paneId: string, targetRowId: string): Workspace {
  const hit = findPane(ws, paneId);
  if (!hit || hit.row.id === targetRowId) return ws;
  const target = ws.rows.find((r) => r.id === targetRowId);
  if (!target || target.panes.length >= MAX_PANES_PER_ROW) return ws;
  const stripped = removePaneRaw(ws, paneId);
  return {
    ...stripped,
    rows: stripped.rows.map((r) => (r.id !== targetRowId ? r : {
      ...r, panes: [...r.panes, hit.pane], split: [...r.split, 1],
    })),
  };
}

/** removePane without the "keep at least one pane" guard — internal. */
function removePaneRaw(ws: Workspace, paneId: string): Workspace {
  const rows: Row[] = [];
  for (const r of ws.rows) {
    const i = r.panes.findIndex((p) => p.id === paneId);
    if (i < 0) { rows.push(r); continue; }
    const panes = r.panes.filter((_, j) => j !== i);
    if (panes.length) rows.push({ ...r, panes, split: r.split.filter((_, j) => j !== i) });
  }
  return { ...ws, rows };
}

// ── resizing ──────────────────────────────────────────────────────────────

/**
 * Move the divider between column `idx` and `idx+1` by `deltaFrac` of the
 * row's total width. Neighbours trade weight between themselves so the rest
 * of the row never shifts, and neither side can be squeezed below MIN_WEIGHT.
 */
export function resizeColumn(ws: Workspace, rowId: string, idx: number,
                             deltaFrac: number): Workspace {
  let changed = false;
  const rows = ws.rows.map((r) => {
    if (r.id !== rowId || idx < 0 || idx + 1 >= r.split.length) return r;
    const total = r.split.reduce((a, b) => a + b, 0);
    const pair = r.split[idx] + r.split[idx + 1];
    const floor = total * MIN_WEIGHT;
    let left = r.split[idx] + deltaFrac * total;
    left = Math.min(Math.max(left, floor), pair - floor);
    if (!Number.isFinite(left) || pair - floor < floor || left === r.split[idx]) return r;
    const split = [...r.split];
    split[idx] = left;
    split[idx + 1] = pair - left;
    changed = true;
    return { ...r, split };
  });
  return changed ? { ...ws, rows } : ws;
}

export function resizeRow(ws: Workspace, idx: number, deltaFrac: number): Workspace {
  if (idx < 0 || idx + 1 >= ws.rows.length) return ws;
  const total = ws.rows.reduce((a, r) => a + r.height, 0);
  const pair = ws.rows[idx].height + ws.rows[idx + 1].height;
  const floor = total * MIN_WEIGHT;
  let top = ws.rows[idx].height + deltaFrac * total;
  top = Math.min(Math.max(top, floor), pair - floor);
  if (!Number.isFinite(top) || pair - floor < floor) return ws;
  return {
    ...ws,
    rows: ws.rows.map((r, i) =>
      i === idx ? { ...r, height: top }
        : i === idx + 1 ? { ...r, height: pair - top } : r),
  };
}

/** Reset every weight to equal — the "tidy up" button. */
export function evenOut(ws: Workspace): Workspace {
  return {
    ...ws,
    rows: ws.rows.map((r) => ({ ...r, height: 1, split: r.panes.map(() => 1) })),
  };
}

// ── normalization / migration ─────────────────────────────────────────────

function cleanWeights(v: unknown, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = Array.isArray(v) ? Number(v[i]) : NaN;
    out.push(Number.isFinite(x) && x > 0 ? x : 1);
  }
  return out;
}

function cleanLink(v: unknown): LinkGroup {
  return LINK_GROUPS.includes(v as LinkGroup) ? (v as LinkGroup) : "A";
}

/**
 * Coerce anything into a renderable Workspace, or null if nothing survives.
 *
 * `knownWidgets` lets the caller drop panes for widgets this build no longer
 * ships — a saved layout from a newer/older version must not render an
 * "Unknown widget" tile forever.
 */
export function normalize(raw: unknown, knownWidgets?: Set<string>): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // v1 layouts were a flat {panes, split} with no rows and no linking. Lift
  // them into a single row and link everything to group A, which reproduces
  // the old behaviour (all panes followed whatever you typed) as closely as
  // the new model allows.
  // NOTE the `.length` checks. The server's Pydantic model defaults `rows` to
  // [], so a v1 document comes back over the wire WITH an empty rows array —
  // testing `Array.isArray(o.rows)` alone made every legacy desk take the v2
  // branch, find no rows, and return null. The user's saved desk was then
  // silently replaced by the default preset.
  const legacyPanes = Array.isArray(o.panes) && o.panes.length ? o.panes : null;
  const rowsRaw = Array.isArray(o.rows) && o.rows.length ? o.rows
    : legacyPanes ? [{ panes: legacyPanes, split: o.split, height: 1 }]
      : null;
  if (!rowsRaw) return null;

  const seen = new Set<string>();
  const rows: Row[] = [];
  let total = 0;

  for (const rr of rowsRaw) {
    if (!rr || typeof rr !== "object") continue;
    const r = rr as Record<string, unknown>;
    const panesRaw = Array.isArray(r.panes) ? r.panes : [];
    const panes: Pane[] = [];
    for (const pp of panesRaw) {
      if (!pp || typeof pp !== "object") continue;
      const p = pp as Record<string, unknown>;
      const widget = typeof p.widget === "string" ? p.widget : "";
      if (!widget) continue;
      if (knownWidgets && !knownWidgets.has(widget)) continue;
      let id = typeof p.id === "string" && p.id ? p.id : newId();
      if (seen.has(id)) id = newId();
      seen.add(id);
      panes.push({
        id, widget, link: cleanLink(p.link),
        ...(typeof p.ticker === "string" && p.ticker.trim()
          ? { ticker: p.ticker.trim().toUpperCase().slice(0, 24) } : {}),
      });
      if (panes.length >= MAX_PANES_PER_ROW) break;
      if (total + panes.length >= MAX_PANES) break;
    }
    if (!panes.length) continue;
    let rid = typeof r.id === "string" && r.id ? r.id : newId("r");
    if (seen.has(rid)) rid = newId("r");
    seen.add(rid);
    const h = Number(r.height);
    rows.push({
      id: rid, panes,
      split: cleanWeights(r.split, panes.length),
      height: Number.isFinite(h) && h > 0 ? h : 1,
    });
    total += panes.length;
    if (rows.length >= MAX_ROWS || total >= MAX_PANES) break;
  }
  if (!rows.length) return null;

  const groups: Record<string, string> = { A: "", B: "", C: "", D: "" };
  const g = o.groups;
  if (g && typeof g === "object") {
    for (const k of ["A", "B", "C", "D"]) {
      const v = (g as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) groups[k] = v.trim().toUpperCase().slice(0, 24);
    }
  }
  // A legacy layout had no groups; seed A from the first pane's ticker so the
  // restored workspace shows the symbol the user actually saved.
  if (!groups.A) {
    const firstTicker = rowsRaw
      .flatMap((r) => (Array.isArray((r as any)?.panes) ? (r as any).panes : []))
      .map((p: any) => (typeof p?.ticker === "string" ? p.ticker : ""))
      .find((t: string) => t.trim());
    groups.A = (firstTicker || DEFAULT_TICKER).toUpperCase();
  }

  return {
    version: WS_VERSION,
    id: typeof o.id === "string" && o.id ? o.id : newId("ws"),
    name: typeof o.name === "string" && o.name.trim()
      ? o.name.trim().slice(0, 60) : "Workspace",
    rows, groups,
  };
}
