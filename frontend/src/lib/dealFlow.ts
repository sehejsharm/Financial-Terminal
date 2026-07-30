/** Reading bulk, block and insider activity.
 *
 *  The Sharks page printed three tables of raw disclosure rows. The numbers
 *  were right; none of them were read, and two of the readings matter a great
 *  deal.
 *
 *  The first is participant count, which sat in a column doing nothing. A net
 *  buy of ₹40 crore from ONE participant is one fund's decision. The same ₹40
 *  crore from twelve participants is a dozen desks arriving at the same view
 *  independently. Those are completely different pieces of information and the
 *  table rendered them identically.
 *
 *  The second is what a bulk deal IS. It is disclosed because it crossed 0.5%
 *  of listed shares — a size threshold, not a conviction threshold — and every
 *  disclosed trade has a buyer and a seller. A large "net buy" across a window
 *  frequently means one holder exited into several buyers, which is a transfer
 *  of ownership rather than accumulation.
 *
 *  And insider rows lumped everything under "type". A promoter buying in the
 *  open market and an ESOP allotment are opposite in information content: one
 *  is someone choosing to spend money, the other is compensation being issued.
 *  Counting them together produces a "insiders are buying" signal out of
 *  payroll.
 */

export type FlowRow = {
  symbol: string;
  deals: number;
  participants: number | null;
  buy_qty: number;
  sell_qty: number;
  net_qty: number;
  buy_value?: number | null;
  sell_value?: number | null;
  net_value?: number | null;
};

/** Column labels shared by the bulk/block deal tables. */
const LABELS: Record<string, string> = {
  symbol: "Symbol",
  ticker: "Ticker",
  name: "Name",
  client: "Client",
  client_name: "Client",
  deal_type: "Side",
  type: "Type",
  qty: "Quantity",
  quantity: "Quantity",
  price: "Price",
  avg_price: "Average price",
  value: "Value",
  date: "Date",
  deals: "Deals",
  participants: "Participants",
  buy_qty: "Buy quantity",
  sell_qty: "Sell quantity",
  net_qty: "Net quantity",
  buy_value: "Buy value",
  sell_value: "Sell value",
  net_value: "Net value",
  person: "Person",
  category: "Category",
  mode: "Mode",
};

export function labelFor(key: string): string {
  return LABELS[key]
    ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// ── how one-sided is the flow, and how many people agreed ─────────────────

/**
 * Net as a share of gross activity, −100 to +100.
 *
 * Net quantity alone says nothing about how one-sided a name was: a net buy of
 * 10,000 shares on gross activity of 20,000 is a lopsided week, and the same
 * net on gross activity of 5,000,000 is noise. This is the ratio that
 * distinguishes them.
 */
export function netSkew(buy: number, sell: number): number | null {
  const gross = buy + sell;
  if (!(gross > 0)) return null;
  return ((buy - sell) / gross) * 100;
}

export type Conviction = "one participant" | "few" | "broad" | "unknown";

/** How many separate parties were involved. One is a decision; a dozen is a
 *  pattern, and the difference is the whole signal. */
export function conviction(participants: number | null | undefined): Conviction {
  if (participants == null || !Number.isFinite(participants) || participants < 1) {
    return "unknown";
  }
  if (participants <= 1) return "one participant";
  if (participants <= 4) return "few";
  return "broad";
}

export type FlowRead = {
  symbol: string;
  netSkewPct: number | null;
  conviction: Conviction;
  participants: number | null;
  deals: number;
  netValue: number | null;
  /** One sentence on what this row does and doesn't say. */
  read: string;
};

export function readFlow(r: FlowRow): FlowRead {
  const skew = netSkew(r.buy_qty, r.sell_qty);
  const c = conviction(r.participants);
  const side = skew == null ? "flat" : skew > 0 ? "bought" : "sold";

  let read: string;
  if (skew == null) {
    read = "No quantity on either side, so there is nothing to read.";
  } else if (Math.abs(skew) < 10) {
    read = `Buying and selling nearly cancel (${skew.toFixed(0)}% net), which is `
      + "what a transfer between holders looks like rather than accumulation.";
  } else if (c === "one participant") {
    read = `Net ${side}, but a SINGLE participant across ${r.deals} `
      + `${r.deals === 1 ? "deal" : "deals"} — one desk's decision, not a `
      + "consensus, and the other side of it is someone equally willing.";
  } else if (c === "broad") {
    read = `Net ${side} at ${Math.abs(skew).toFixed(0)}% of gross activity across `
      + `${r.participants} separate participants — the closest this data comes `
      + "to independent agreement.";
  } else if (c === "few") {
    read = `Net ${side} across ${r.participants} participants. Few enough that `
      + "one or two of them drive the whole figure.";
  } else {
    read = `Net ${side} at ${Math.abs(skew).toFixed(0)}% of gross activity; the `
      + "participant count wasn't disclosed, so there is no way to tell how "
      + "many parties this represents.";
  }
  return {
    symbol: r.symbol,
    netSkewPct: skew,
    conviction: c,
    participants: r.participants ?? null,
    deals: r.deals,
    netValue: r.net_value ?? null,
    read,
  };
}

/**
 * The rows worth looking at first.
 *
 * Ranked by net value magnitude, but ONLY among rows that are actually
 * one-sided. A ₹500 crore name whose buying and selling cancel is a big
 * transfer, not a big signal, and putting it at the top of a "flow" list
 * misdirects the reader to the least informative row on the page.
 */
export const ONE_SIDED_PCT = 20;

export function rankFlow(rows: FlowRow[], minSkew = ONE_SIDED_PCT): FlowRead[] {
  return rows
    .map(readFlow)
    .filter((r) => r.netSkewPct != null && Math.abs(r.netSkewPct) >= minSkew)
    .sort((a, b) => Math.abs(b.netValue ?? 0) - Math.abs(a.netValue ?? 0));
}

export function flowNote(rows: FlowRow[], ranked: FlowRead[],
                         from: string | null, to: string | null): string {
  if (!rows.length) return "No bulk-deal activity in this window.";
  const parts: string[] = [];

  parts.push(from && to
    ? `${rows.length} symbols with disclosed bulk activity between ${from} and ${to}.`
    : `${rows.length} symbols with disclosed bulk activity.`);

  const oneSided = ranked.length;
  parts.push(`${oneSided} of them are genuinely one-sided (net above `
    + `${ONE_SIDED_PCT}% of gross activity). The rest had buying and selling `
    + "roughly cancel, which is a transfer between holders rather than "
    + "accumulation — and net quantity on its own cannot tell the two apart.");

  const solo = ranked.filter((r) => r.conviction === "one participant").length;
  if (solo) {
    parts.push(`${solo} of the one-sided names involve a SINGLE participant. `
      + "That is one desk's decision, and it reads identically to a dozen desks "
      + "agreeing unless the participant count is shown beside it.");
  }

  parts.push("A bulk deal is disclosed because it crossed 0.5% of listed shares "
    + "— a SIZE threshold, not a conviction one. Every one of these trades also "
    + "has a willing party on the other side, and end-of-day disclosure means "
    + "the price has already moved by the time you read it.");
  return parts.join(" ");
}

// ── insider disclosures ───────────────────────────────────────────────────

export type InsiderKind = "open-market buy" | "open-market sell" | "allotment"
  | "pledge" | "gift or transfer" | "other";

const KIND_RULES: ReadonlyArray<{ kind: InsiderKind; test: RegExp }> = [
  // Order matters: an "ESOP" row often also contains "acquisition".
  { kind: "allotment", test: /esop|espp|allot|exercis|grant|rsu|option|preferential/i },
  { kind: "pledge", test: /pledg|invok|revok|encumb/i },
  { kind: "gift or transfer", test: /gift|inherit|transmis|inter-?se|off.?market/i },
  { kind: "open-market buy", test: /\b(buy|bought|purchase|acquisition|acquire)/i },
  { kind: "open-market sell", test: /\b(sell|sold|sale|dispos)/i },
];

/**
 * What an insider row actually is.
 *
 * The distinction the page was missing: an ESOP allotment is compensation
 * being issued, not someone choosing to spend money on shares. Counting the
 * two together manufactures an "insiders are buying" signal out of payroll,
 * which is the most common way this data is misread.
 */
export function insiderKind(type?: string | null, mode?: string | null): InsiderKind {
  const hay = `${type ?? ""} ${mode ?? ""}`;
  if (!hay.trim()) return "other";
  for (const r of KIND_RULES) if (r.test.test(hay)) return r.kind;
  return "other";
}

export type InsiderSummary = {
  buys: number;
  sells: number;
  allotments: number;
  pledges: number;
  other: number;
  total: number;
  /** Buys minus sells, counting only genuine open-market decisions. */
  netDecisions: number;
};

export function summariseInsiders(
    rows: { type?: string | null; mode?: string | null }[]): InsiderSummary {
  const s: InsiderSummary = {
    buys: 0, sells: 0, allotments: 0, pledges: 0, other: 0,
    total: rows.length, netDecisions: 0,
  };
  for (const r of rows) {
    switch (insiderKind(r.type, r.mode)) {
      case "open-market buy": s.buys++; break;
      case "open-market sell": s.sells++; break;
      case "allotment": s.allotments++; break;
      case "pledge": s.pledges++; break;
      default: s.other++;
    }
  }
  s.netDecisions = s.buys - s.sells;
  return s;
}

export function insiderNote(s: InsiderSummary): string {
  if (!s.total) return "No insider disclosures in the current window.";
  const parts: string[] = [];

  parts.push(`${s.total} disclosures: ${s.buys} open-market `
    + `${s.buys === 1 ? "buy" : "buys"}, ${s.sells} `
    + `${s.sells === 1 ? "sale" : "sales"}, ${s.allotments} allotment`
    + `${s.allotments === 1 ? "" : "s"} and ${s.pledges} pledge-related.`);

  if (s.allotments) {
    parts.push("Allotments are counted SEPARATELY on purpose. An ESOP or grant "
      + "is compensation being issued, not someone choosing to spend money on "
      + "shares — folding them into the buy count manufactures an “insiders are "
      + "buying” signal out of payroll.");
  }
  if (s.pledges) {
    parts.push("Pledges are neither: they are a promoter borrowing against "
      + "stock, which says something about their balance sheet rather than "
      + "their view of the company.");
  }
  parts.push("Insiders sell for reasons that have nothing to do with the "
    + "business — tax, a house, diversification — so sales carry much less "
    + "information than buys. Disclosure also lags the trade, and these are "
    + "filings scraped best-effort rather than a complete record.");
  return parts.join(" ");
}

/** What the raw bulk/block tables are, for the reader who lands on them. */
export function dealsNote(kind: "bulk" | "block", n: number): string {
  const what = kind === "bulk"
    ? "A bulk deal is any trade above 0.5% of a company's listed shares, "
      + "aggregated per client per day across the whole session."
    : "A block deal is a single negotiated trade of at least ₹10 crore, "
      + "executed in a dedicated window at a price near the reference.";
  return `${n} disclosed ${kind} ${n === 1 ? "deal" : "deals"}. ${what} `
    + "Disclosure is triggered by SIZE, not by conviction, and every row has a "
    + "counterparty who took the other side willingly. NSE publishes these "
    + "end-of-day, so the price has already reacted by the time this list "
    + "exists — treat it as a record of who moved, not a trade to follow.";
}
