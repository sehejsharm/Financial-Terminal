/** Pure geometry/graph helpers for the value-chain map.
 *
 *  Kept out of the component so the maths is unit-testable without a DOM:
 *  viewport fitting, entity de-duplication, edge-metric selection and
 *  snapshot diffing.
 */
import type { ChainNode, ValueChain } from "@/lib/api";

/** Canvas coordinate space the SVG viewBox is expressed in. */
export const W = 1200;
export const H = 780;
export const CX = W / 2;
export const CY = 340;

/** Zoom limits, expressed on the viewBox WIDTH (smaller = more zoomed in). */
export const MIN_W = W / 8;
export const MAX_W = W * 3;

export type View = { x: number; y: number; w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const DEFAULT_VIEW: View = { x: 0, y: 0, w: W, h: H };

/** Node box half-extents used by the renderer (rect is 156×32 centred on x,y). */
export const NODE_HALF_W = 78;
export const NODE_HALF_H = 16;

/**
 * Smallest view that frames every point, padded, widened to the canvas aspect
 * ratio and clamped to the zoom limits. Returns DEFAULT_VIEW for an empty
 * graph so "Fit" always does something sane.
 */
export function fitView(
  points: { x: number; y: number }[],
  opts: { pad?: number; halfW?: number; halfH?: number } = {},
): View {
  const { pad = 24, halfW = NODE_HALF_W, halfH = NODE_HALF_H } = opts;
  if (!points.length) return { ...DEFAULT_VIEW };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    xs.push(p.x - halfW, p.x + halfW);
    ys.push(p.y - halfH, p.y + halfH);
  }
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  let w = maxX - minX;
  const h = maxY - minY;
  // Grow the tighter axis so the framed box keeps the canvas aspect ratio.
  if (w / h < W / H) w = h * (W / H);
  w = clamp(w, MIN_W, MAX_W);
  const fh = w * (H / W);
  return { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - fh / 2, w, h: fh };
}

/**
 * Zoom anchored on a point given in 0..1 fractions of the viewport, so the
 * graph coordinate under the cursor stays under the cursor.
 */
export function zoomAt(view: View, factor: number, fx: number, fy: number): View {
  const w = clamp(view.w * factor, MIN_W, MAX_W);
  const h = w * (H / W);
  return {
    x: view.x + (view.w - w) * clamp(fx, 0, 1),
    y: view.y + (view.h - h) * clamp(fy, 0, 1),
    w,
    h,
  };
}

// ── entity de-duplication ──────────────────────────────────────────────────
// The API models role positionally (three parallel arrays), so a company that
// is both a customer AND a competitor arrives twice and used to render as two
// disconnected nodes. We merge on identity and carry `roles: Role[]`.

export type Role = "supplier" | "customer" | "competitor";

/** Placement precedence when an entity holds several roles: a physical flow
 *  (supplies to / buys from) is more structural than peer rivalry. */
export const ROLE_ORDER: Role[] = ["supplier", "customer", "competitor"];

/** Corporate-form noise that shouldn't split "Tata Motors" from
 *  "Tata Motors Ltd." into two nodes. */
const SUFFIXES = new Set([
  "inc", "inc.", "incorporated", "ltd", "ltd.", "limited", "llc", "llp", "plc",
  "corp", "corp.", "corporation", "co", "co.", "company", "sa", "s.a.", "ag",
  "nv", "n.v.", "spa", "s.p.a.", "gmbh", "ab", "as", "oyj", "pte", "pvt",
  "group", "holdings", "holding", "the",
]);

/** Identity key for matching the same company across roles: case/punctuation/
 *  corporate-suffix insensitive. Exported for tests. */
export function entityKey(name: string): string {
  const words = (name || "")
    .toLowerCase()
    .replace(/[&/]/g, " ")
    .replace(/[^a-z0-9\s.]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !SUFFIXES.has(w));
  const joined = words.join(" ").replace(/\./g, "").trim();
  return joined || (name || "").toLowerCase().trim();
}

export type MergedEntity = {
  key: string;
  name: string;
  /** Every role this entity plays, in ROLE_ORDER. */
  roles: Role[];
  /** Role that decides which column it is drawn in. */
  primaryRole: Role;
  /** revenue_pct is role-specific — for a supplier it means share of INPUT
   *  COSTS, for a customer share of REVENUE. Never collapse them into one
   *  number; keep them separate and label per role. */
  pctByRole: Partial<Record<Role, number | null>>;
  notesByRole: Partial<Record<Role, string>>;
  note?: string;
  revenue_pct?: number | null;
  ticker?: string | null;
  confidence?: "estimated" | "verified";
  verified_at?: string | null;
  /** The original per-role nodes, so reports/overrides can still address the
   *  exact (role, name) pair the backend stores. */
  sources: Partial<Record<Role, ChainNode>>;
};

function firstRole(roles: Role[]): Role {
  for (const r of ROLE_ORDER) if (roles.includes(r)) return r;
  return roles[0] ?? "competitor";
}

/**
 * Find an existing key that is the same company under a longer/shorter name
 * ("Samsung" vs "Samsung Electronics") — the LLM routinely varies how much of
 * a name it writes between roles.
 *
 * Deliberately conservative: only a WHOLE-WORD prefix relationship counts, so
 * "Tata Motors" and "Tata Steel" stay separate (neither is a prefix of the
 * other). A false merge is worse than a duplicate node in a research tool, so
 * we never do token-overlap or edit-distance matching here.
 */
export function findAliasKey(key: string, existing: Iterable<string>): string | null {
  if (key.length < 4) return null;
  for (const k of existing) {
    if (k === key) return k;
    if (k.length >= 4 && (k.startsWith(`${key} `) || key.startsWith(`${k} `))) return k;
  }
  return null;
}

/**
 * Merge the three positional arrays into one de-duplicated entity list.
 * Entities match on `entityKey(name)`, or on an identical explicit ticker
 * (which beats name spelling). Verified provenance wins over estimated.
 */
export function mergeEntities(data: Pick<ValueChain, "suppliers" | "customers" | "competitors">): MergedEntity[] {
  const byKey = new Map<string, MergedEntity>();
  const byTicker = new Map<string, string>(); // ticker -> key

  const ingest = (role: Role, nodes?: ChainNode[]) => {
    for (const n of nodes ?? []) {
      if (!n?.name) continue;
      const tk = (n.ticker || "").trim().toUpperCase();
      let key = entityKey(n.name);
      // Same explicit ticker => same company even if names differ.
      if (tk && byTicker.has(tk)) key = byTicker.get(tk)!;
      else {
        const alias = findAliasKey(key, byKey.keys());
        if (alias) key = alias;
      }
      if (tk && !byTicker.has(tk)) byTicker.set(tk, key);

      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, {
          key,
          name: n.name,
          roles: [role],
          primaryRole: role,
          pctByRole: { [role]: n.revenue_pct ?? null },
          notesByRole: n.note ? { [role]: n.note } : {},
          note: n.note,
          revenue_pct: n.revenue_pct ?? null,
          ticker: n.ticker ?? null,
          confidence: n.confidence ?? "estimated",
          verified_at: n.verified_at ?? null,
          sources: { [role]: n },
        });
        continue;
      }
      if (!cur.roles.includes(role)) cur.roles.push(role);
      cur.pctByRole[role] = n.revenue_pct ?? null;
      if (n.note) cur.notesByRole[role] = n.note;
      cur.sources[role] = n;
      if (!cur.ticker && n.ticker) cur.ticker = n.ticker;
      // Any verified occurrence promotes the whole entity's provenance.
      if (n.confidence === "verified") {
        cur.confidence = "verified";
        cur.verified_at = cur.verified_at ?? n.verified_at ?? null;
      }
      // Prefer the longer, more specific name spelling.
      if (n.name.length > cur.name.length) cur.name = n.name;
    }
  };

  ingest("supplier", data.suppliers);
  ingest("customer", data.customers);
  ingest("competitor", data.competitors);

  for (const e of byKey.values()) {
    e.roles.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
    e.primaryRole = firstRole(e.roles);
    e.note = e.notesByRole[e.primaryRole] ?? Object.values(e.notesByRole)[0];
    e.revenue_pct = e.pctByRole[e.primaryRole] ?? null;
  }
  return [...byKey.values()];
}
