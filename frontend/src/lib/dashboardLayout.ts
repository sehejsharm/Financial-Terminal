/** Dashboard layout: the user's arrangement of sections, and the pure
 *  operations that edit it.
 *
 *  Kept out of the component so every mutation is unit-testable, and so the
 *  persistence path has one hardened entry point. `normalize()` is the
 *  important function here: a layout comes back out of localStorage, which
 *  means it can be from an older build, hand-edited, truncated, or outright
 *  garbage. It must ALWAYS yield a renderable layout — a dashboard that
 *  white-screens because a stale blob had a null in it is a much worse bug
 *  than a dashboard that quietly drops one unknown section.
 */
import { preset, region, SECTION_PRESETS, type RegionId } from "@/lib/instruments";

export type SectionKind = "tiles" | "movers" | "watchlists";

export type Section = {
  id: string;
  kind: SectionKind;
  title: string;
  /** Only meaningful for kind "tiles". */
  symbols: string[];
  collapsed?: boolean;
};

export type Layout = {
  version: number;
  regionId: RegionId;
  sections: Section[];
  /** Hide tiles the feed can't price, instead of showing a row of dashes. */
  hideUnpriced?: boolean;
  /** Tighter tiles — more instruments per screen. */
  dense?: boolean;
};

export const LAYOUT_VERSION = 1;
export const LAYOUT_KEY = "mb_dashboard_layout_v1";
export const MAX_SECTIONS = 24;
export const MAX_SYMBOLS_PER_SECTION = 40;

let seq = 0;
/** Unique-enough section id. Not crypto — it only has to not collide within
 *  one user's layout, and it must be stable once assigned so React keys and
 *  reorder operations stay attached to the right section. */
export function newSectionId(prefix = "s"): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

// ── construction ──────────────────────────────────────────────────────────

/** The two always-present boards, below the market tiles as requested. */
function tailSections(): Section[] {
  return [
    { id: newSectionId("movers"), kind: "movers", title: "Gainers & losers", symbols: [] },
    { id: newSectionId("watch"), kind: "watchlists", title: "Watchlists", symbols: [] },
  ];
}

export function defaultLayout(regionId: RegionId): Layout {
  const r = region(regionId);
  const tiles: Section[] = r.layout
    .map((pid) => preset(pid))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({
      id: newSectionId(p.id),
      kind: "tiles" as const,
      title: p.title,
      symbols: [...p.symbols],
    }));
  return {
    version: LAYOUT_VERSION,
    regionId: r.id,
    sections: [...tiles, ...tailSections()],
    hideUnpriced: false,
    dense: false,
  };
}

// ── normalization / persistence ───────────────────────────────────────────

const KINDS: SectionKind[] = ["tiles", "movers", "watchlists"];

function cleanSymbols(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") continue;
    const t = s.trim().toUpperCase();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_SYMBOLS_PER_SECTION) break;
  }
  return out;
}

/**
 * Coerce anything into a valid Layout. Returns null only when there is
 * nothing salvageable, so callers fall back to a default rather than render
 * a broken board.
 */
export function normalize(raw: unknown): Layout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== "number" || o.version > LAYOUT_VERSION) return null;

  const seen = new Set<string>();
  const sections: Section[] = [];
  for (const s of Array.isArray(o.sections) ? o.sections : []) {
    if (!s || typeof s !== "object") continue;
    const sec = s as Record<string, unknown>;
    const kind = KINDS.includes(sec.kind as SectionKind) ? (sec.kind as SectionKind) : null;
    if (!kind) continue;
    // A duplicated id would make React reuse the wrong node and make reorder
    // ambiguous, so re-mint rather than drop the section.
    let id = typeof sec.id === "string" && sec.id ? sec.id : newSectionId();
    if (seen.has(id)) id = newSectionId();
    seen.add(id);
    const symbols = cleanSymbols(sec.symbols);
    // An empty tile board renders as a header over nothing.
    if (kind === "tiles" && symbols.length === 0) continue;
    sections.push({
      id, kind,
      title: typeof sec.title === "string" && sec.title.trim()
        ? sec.title.slice(0, 60) : "Untitled",
      symbols,
      collapsed: sec.collapsed === true,
    });
    if (sections.length >= MAX_SECTIONS) break;
  }
  if (sections.length === 0) return null;

  return {
    version: LAYOUT_VERSION,
    regionId: region(typeof o.regionId === "string" ? o.regionId : null).id,
    sections,
    hideUnpriced: o.hideUnpriced === true,
    dense: o.dense === true,
  };
}

export function loadLayout(): Layout | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveLayout(l: Layout): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); }
  catch { /* private mode / quota — the layout just won't persist */ }
}

// ── pure edits ────────────────────────────────────────────────────────────
// Every one returns a NEW layout; none mutate. That keeps React state updates
// honest and makes each operation trivially testable.

export function moveSection(l: Layout, id: string, dir: -1 | 1): Layout {
  const i = l.sections.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= l.sections.length) return l;   // already at an end
  const sections = [...l.sections];
  [sections[i], sections[j]] = [sections[j], sections[i]];
  return { ...l, sections };
}

export function removeSection(l: Layout, id: string): Layout {
  const sections = l.sections.filter((s) => s.id !== id);
  return sections.length === l.sections.length ? l : { ...l, sections };
}

export function toggleCollapsed(l: Layout, id: string): Layout {
  return {
    ...l,
    sections: l.sections.map((s) =>
      s.id === id ? { ...s, collapsed: !s.collapsed } : s),
  };
}

export function renameSection(l: Layout, id: string, title: string): Layout {
  const t = title.trim().slice(0, 60);
  if (!t) return l;
  return { ...l, sections: l.sections.map((s) => (s.id === id ? { ...s, title: t } : s)) };
}

/** Insert a preset board. Tile sections land above the movers/watchlist tail
 *  so the market data stays at the top where it belongs. */
export function addPresetSection(l: Layout, presetId: string): Layout {
  const p = preset(presetId);
  if (!p || l.sections.length >= MAX_SECTIONS) return l;
  const sec: Section = {
    id: newSectionId(p.id), kind: "tiles", title: p.title, symbols: [...p.symbols],
  };
  const firstTail = l.sections.findIndex((s) => s.kind !== "tiles");
  const sections = [...l.sections];
  sections.splice(firstTail < 0 ? sections.length : firstTail, 0, sec);
  return { ...l, sections };
}

export function addCustomSection(l: Layout, title: string): Layout {
  if (l.sections.length >= MAX_SECTIONS) return l;
  const sec: Section = {
    id: newSectionId("custom"), kind: "tiles",
    title: title.trim().slice(0, 60) || "My board",
    // Seeded with one symbol so it isn't dropped by normalize() on reload
    // before the user has added anything to it.
    symbols: ["^NSEI"],
  };
  const firstTail = l.sections.findIndex((s) => s.kind !== "tiles");
  const sections = [...l.sections];
  sections.splice(firstTail < 0 ? sections.length : firstTail, 0, sec);
  return { ...l, sections };
}

/** Re-add a board that was removed (movers / watchlists). */
export function addBoardSection(l: Layout, kind: SectionKind, title: string): Layout {
  if (kind === "tiles" || l.sections.some((s) => s.kind === kind)) return l;
  if (l.sections.length >= MAX_SECTIONS) return l;
  return { ...l, sections: [...l.sections, { id: newSectionId(kind), kind, title, symbols: [] }] };
}

export function addSymbol(l: Layout, sectionId: string, sym: string): Layout {
  const s = sym.trim().toUpperCase();
  if (!s) return l;
  return {
    ...l,
    sections: l.sections.map((sec) => {
      if (sec.id !== sectionId || sec.kind !== "tiles") return sec;
      if (sec.symbols.includes(s) || sec.symbols.length >= MAX_SYMBOLS_PER_SECTION) return sec;
      return { ...sec, symbols: [...sec.symbols, s] };
    }),
  };
}

export function removeSymbol(l: Layout, sectionId: string, sym: string): Layout {
  return {
    ...l,
    sections: l.sections.map((sec) =>
      sec.id === sectionId
        ? { ...sec, symbols: sec.symbols.filter((x) => x !== sym) }
        : sec),
  };
}

export function moveSymbol(l: Layout, sectionId: string, sym: string, dir: -1 | 1): Layout {
  return {
    ...l,
    sections: l.sections.map((sec) => {
      if (sec.id !== sectionId) return sec;
      const i = sec.symbols.indexOf(sym);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sec.symbols.length) return sec;
      const symbols = [...sec.symbols];
      [symbols[i], symbols[j]] = [symbols[j], symbols[i]];
      return { ...sec, symbols };
    }),
  };
}

/** Every symbol on the board — one bulk socket subscription for the page. */
export function allSymbols(l: Layout): string[] {
  const out = new Set<string>();
  for (const s of l.sections) {
    if (s.kind === "tiles") s.symbols.forEach((x) => out.add(x));
  }
  return [...out];
}

/** Preset ids not currently on the board, for the "add section" picker. */
export function availablePresets(l: Layout): string[] {
  const used = new Set(l.sections.map((s) => s.title));
  return SECTION_PRESETS.filter((p) => !used.has(p.title)).map((p) => p.id);
}
