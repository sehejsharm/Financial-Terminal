/** Cross-module overlays for the value-chain graph.
 *
 *  The graph is the one place a user is already looking at a company's whole
 *  counterparty set, so it's where signals from the OTHER modules belong:
 *  what you hold (Portfolio), who's been trading it (Big Sharks), and what
 *  just got published about it (News).
 *
 *  Matching is pure and unit-tested here because a false positive is
 *  expensive: badging the wrong node with "insider bought" is worse than
 *  badging nothing.
 */
import { entityKey, findAliasKey, type MergedEntity } from "@/lib/valueChainGraph";

export type HeldInfo = {
  ticker: string;
  qty: number;
  value: number | null;
  pnlPct: number | null;
};

export type DealMark = {
  kind: "bulk" | "block" | "insider";
  side: "buy" | "sell" | "unknown";
  label: string;
  value: number | null;
  date: string | null;
};

export type NewsHit = {
  title: string;
  link: string;
  published: string | null;
  publisher?: string;
};

export type NodeOverlay = {
  held?: HeldInfo;
  deals: DealMark[];
  news: NewsHit[];
  /** A headline for this node arrived since the last poll — drives the pulse. */
  fresh?: boolean;
};

// ── text matching ──────────────────────────────────────────────────────────

/** Normalise free text the same way entity names are normalised, so a
 *  headline and a node name are compared on the same footing. */
function normText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Names too generic to match on — a headline containing "Retail" must not
 *  light up a node called "Retail". */
const STOPWORD_NAMES = new Set([
  "retail", "energy", "power", "telecom", "digital", "media", "finance",
  "capital", "bank", "banks", "motors", "steel", "cement", "chemicals",
  "consumers", "customers", "suppliers", "others", "various", "segment",
]);

/**
 * Does `text` actually mention this entity?
 *
 * Requires the entity's WHOLE normalised name to appear as a contiguous word
 * sequence — "Tata Motors" does not match a headline about "Tata Steel", and
 * a bare first token never matches on its own. Single-word names must be
 * distinctive (length ≥ 4 and not an industry stopword).
 */
export function textMentionsEntity(text: string, name: string): boolean {
  const key = entityKey(name);
  if (!key || key.length < 4) return false;
  const words = key.split(" ").filter(Boolean);
  if (words.length === 1 && STOPWORD_NAMES.has(words[0])) return false;
  const hay = ` ${normText(text)} `;
  return hay.includes(` ${key} `)
    // also allow the name to be followed by punctuation-stripped suffixes
    || hay.includes(` ${key}s `);
}

/** Bare exchange symbol for comparison ("HPCL.NS" -> "HPCL"). */
export function bareSymbol(sym: string | null | undefined): string {
  const s = (sym || "").trim().toUpperCase();
  const dot = s.indexOf(".");
  return dot > 0 ? s.slice(0, dot) : s;
}

/** Does this exchange symbol refer to this entity? Matches the AI's ticker
 *  hint when present, otherwise falls back to the name. */
export function symbolMatchesEntity(sym: string | null | undefined, e: MergedEntity): boolean {
  const bare = bareSymbol(sym);
  if (!bare) return false;
  if (e.ticker && bareSymbol(e.ticker) === bare) return true;
  // A symbol is not a name, but NSE symbols are usually the name's first
  // token(s) squashed ("TATAMOTORS"); compare against the squashed key.
  const squashed = entityKey(e.name).replace(/\s+/g, "");
  return squashed.length >= 4 && squashed === bare.toLowerCase();
}

// ── overlay index ──────────────────────────────────────────────────────────

export type OverlaySources = {
  positions?: { ticker: string; qty: number; value?: number | null; pnl_pct?: number | null }[];
  bulk?: Record<string, unknown>[];
  block?: Record<string, unknown>[];
  insider?: Record<string, unknown>[];
  news?: NewsHit[];
  /** Links already seen — anything new pulses. */
  seenLinks?: Set<string>;
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Buy/sell from an NSE deal row's transaction-type column. */
function dealSide(row: Record<string, unknown>): "buy" | "sell" | "unknown" {
  const t = str(row.buySell ?? row.buy_sell ?? row.type ?? row.transaction_type
                ?? row.BuySell ?? "").toLowerCase();
  if (t.startsWith("b") || t.includes("acqui") || t.includes("purchase")) return "buy";
  if (t.startsWith("s") || t.includes("dispos") || t.includes("sale")) return "sell";
  return "unknown";
}

/**
 * Build the per-entity overlay index. Keyed by the merged entity's key so the
 * component can look up by node in O(1).
 */
export function buildOverlayIndex(
  entities: MergedEntity[],
  src: OverlaySources,
): Map<string, NodeOverlay> {
  const idx = new Map<string, NodeOverlay>();
  for (const e of entities) idx.set(e.key, { deals: [], news: [] });

  const forEntity = (e: MergedEntity) => idx.get(e.key)!;

  // ── holdings ──
  for (const p of src.positions ?? []) {
    for (const e of entities) {
      if (!symbolMatchesEntity(p.ticker, e)) continue;
      forEntity(e).held = {
        ticker: p.ticker,
        qty: p.qty,
        value: p.value ?? null,
        pnlPct: p.pnl_pct ?? null,
      };
    }
  }

  // ── bulk / block deals ──
  const pushDeals = (rows: Record<string, unknown>[] | undefined,
                     kind: "bulk" | "block") => {
    for (const row of rows ?? []) {
      const sym = str(row.symbol ?? row.Symbol ?? row.ticker);
      const client = str(row.clientName ?? row.client_name ?? row.client ?? "");
      for (const e of entities) {
        if (!symbolMatchesEntity(sym, e)) continue;
        forEntity(e).deals.push({
          kind,
          side: dealSide(row),
          label: client || `${kind} deal`,
          value: num(row.tradedQuantity ?? row.quantity ?? row.qty ?? row.value),
          date: str(row.date ?? row.Date ?? row.ts) || null,
        });
      }
    }
  };
  pushDeals(src.bulk, "bulk");
  pushDeals(src.block, "block");

  // ── insider (PIT) disclosures ──
  for (const row of src.insider ?? []) {
    const sym = str(row.symbol ?? row.Symbol);
    for (const e of entities) {
      if (!symbolMatchesEntity(sym, e)) continue;
      forEntity(e).deals.push({
        kind: "insider",
        side: dealSide(row),
        label: str(row.person ?? row.name ?? "insider"),
        value: num(row.value ?? row.qty),
        date: str(row.date ?? row.ts) || null,
      });
    }
  }

  // ── news ──
  for (const n of src.news ?? []) {
    const text = `${n.title} ${n.publisher ?? ""}`;
    for (const e of entities) {
      if (!textMentionsEntity(text, e.name)) continue;
      const slot = forEntity(e);
      if (slot.news.some((x) => x.link === n.link)) continue;
      slot.news.push(n);
      // Unseen link => this landed while the user was looking at the graph.
      if (src.seenLinks && !src.seenLinks.has(n.link)) slot.fresh = true;
    }
  }

  // Newest headlines first.
  for (const o of idx.values()) {
    o.news.sort((a, b) => (Date.parse(b.published || "") || 0) - (Date.parse(a.published || "") || 0));
    o.news = o.news.slice(0, 5);
    o.deals = o.deals.slice(0, 4);
  }
  return idx;
}

/** Overlay lookup tolerant of name-variant keys (same rule as the merge). */
export function overlayFor(
  idx: Map<string, NodeOverlay>, key: string,
): NodeOverlay | undefined {
  const hit = idx.get(key);
  if (hit) return hit;
  const alias = findAliasKey(key, idx.keys());
  return alias ? idx.get(alias) : undefined;
}
