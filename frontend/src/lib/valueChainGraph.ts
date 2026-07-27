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
  /** Full quantitative measure set per role (pct of revenue / pct of input
   *  costs / est. USD value / YoY), for the metric toggle. */
  metricsByRole: Partial<Record<Role, EdgeMetrics>>;
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
          metricsByRole: { [role]: readMetrics(n, role) },
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
      cur.metricsByRole[role] = readMetrics(n, role);
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

// ── quantitative edge weighting ────────────────────────────────────────────
// An edge can carry several measures; the user picks which one drives the
// visual weight. They are NOT interchangeable (a % of revenue and a dollar
// value aren't the same scale), so each is normalised on its own terms and
// the UI always says which measure it actually used for a given edge.

export type EdgeMetric = "pctRevenue" | "pctCOGS" | "estUSDValue";

export const EDGE_METRIC_LABEL: Record<EdgeMetric, string> = {
  pctRevenue: "% of revenue",
  pctCOGS: "% of input costs",
  estUSDValue: "est. $ value",
};

/** Per-role quantitative measures, camelCased from the snake_case wire. */
export type EdgeMetrics = {
  pctRevenue: number | null;
  pctCOGS: number | null;
  estUSDValue: number | null;
  yoyPct: number | null;
};

export function readMetrics(n: ChainNode | undefined, role: Role): EdgeMetrics {
  if (!n) return { pctRevenue: null, pctCOGS: null, estUSDValue: null, yoyPct: null };
  // Legacy `revenue_pct` is role-dependent: revenue share for a customer,
  // input-cost share for a supplier. Map it to the right modern field so old
  // maps (pins, history snapshots) still weight correctly.
  const legacyRevenue = role === "customer" ? n.revenue_pct ?? null : null;
  const legacyCogs = role === "supplier" ? n.revenue_pct ?? null : null;
  return {
    pctRevenue: n.pct_revenue ?? legacyRevenue,
    pctCOGS: n.pct_cogs ?? legacyCogs,
    estUSDValue: n.est_usd_value ?? null,
    yoyPct: n.yoy_pct ?? null,
  };
}

/**
 * Resolve which measure to draw an edge with. Returns the requested metric
 * when present; otherwise falls back to whatever the model DID give, and
 * reports it, so the UI can be honest that this edge is weighted by a
 * different measure than the one selected.
 */
export function resolveMetric(
  m: EdgeMetrics, want: EdgeMetric,
): { value: number | null; used: EdgeMetric | null; fellBack: boolean } {
  const order: EdgeMetric[] = [want,
    ...(["pctRevenue", "pctCOGS", "estUSDValue"] as EdgeMetric[]).filter((k) => k !== want)];
  for (const k of order) {
    const v = m[k];
    if (v != null && Number.isFinite(v)) return { value: v, used: k, fellBack: k !== want };
  }
  return { value: null, used: null, fellBack: false };
}

/** Largest USD value in the graph — dollar edges are normalised against it
 *  (percentages use their own absolute 0-100 scale instead). */
export function maxUsd(values: (number | null | undefined)[]): number {
  let max = 0;
  for (const v of values) if (v != null && Number.isFinite(v) && v > max) max = v;
  return max;
}

/** Stroke width for an edge, scaled per metric kind. */
export function edgeWidthFor(value: number | null, used: EdgeMetric | null, usdMax = 0): number {
  if (value == null || used == null) return 1.2;
  if (used === "estUSDValue") {
    if (usdMax <= 0) return 1.2;
    // sqrt so one mega-contract doesn't flatten every other edge to a hair.
    return clamp(1.2 + 4.8 * Math.sqrt(clamp(value / usdMax, 0, 1)), 1.2, 6);
  }
  return clamp(1 + value / 10, 1.2, 6);
}

/** Stroke opacity for an edge, same scaling rules as the width. */
export function edgeOpacityFor(value: number | null, used: EdgeMetric | null, usdMax = 0): number {
  if (value == null || used == null) return 0.35;
  if (used === "estUSDValue") {
    if (usdMax <= 0) return 0.35;
    return clamp(0.3 + 0.6 * Math.sqrt(clamp(value / usdMax, 0, 1)), 0.3, 0.9);
  }
  return clamp(0.3 + value / 80, 0.3, 0.9);
}

/** Compact human form for a dollar edge value ($2.4B). */
export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  for (const [div, suf] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (a >= div) return `$${(v / div).toFixed(a / div >= 100 ? 0 : 1)}${suf}`;
  }
  return `$${v.toFixed(0)}`;
}

/**
 * Look up aggregate report counts for a merged entity.
 *
 * The server keys counts by normalised name; a merged entity's own key is
 * whichever spelling was ingested first. Rather than trusting those to match,
 * sum every count key that alias-matches this entity — so a node that merged
 * "Samsung" and "Samsung Electronics" shows the combined flag count instead
 * of silently dropping half of it.
 */
export function lookupReportCount(
  counts: Record<string, { count: number }>, key: string,
): number {
  let total = 0;
  for (const [k, v] of Object.entries(counts)) {
    const match = k === key
      || (key.length >= 4 && k.length >= 4
          && (k.startsWith(`${key} `) || key.startsWith(`${k} `)));
    if (match) total += v?.count ?? 0;
  }
  return total;
}
