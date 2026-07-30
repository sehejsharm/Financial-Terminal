/** What the book is actually doing.
 *
 *  PORT showed a total P&L, a weighted beta and a sector bar chart. All three
 *  are true and none of them answers the question a holder opens the screen
 *  with: where did the money come from, and what am I actually exposed to.
 *
 *  A +₹4.2L total says nothing about whether it is one position carrying nine
 *  losers. A sector chart with eight bars says nothing about concentration —
 *  "largest position is 34%" was the only concentration figure, and a book of
 *  three positions at 33% each passes that test while being about as
 *  undiversified as a book can be. And a weighted beta hides which holdings
 *  supply it, which is the only actionable form of the number.
 *
 *  So: contribution to P&L, real concentration measures, and where the beta
 *  comes from. Pure, because the arithmetic has sign traps in it — a loss on a
 *  short weight, a negative cost basis, a book whose value is zero — and each
 *  one deserves a test rather than a runtime surprise.
 */

export type Row = {
  id?: string;
  ticker: string;
  qty: number;
  cost: number;
  sector?: string | null;
  beta?: number | null;
  price?: number | null;
  value?: number | null;
  pnl?: number | null;
  pnl_pct?: number | null;
  day_pnl?: number | null;
  weight?: number | null;
  currency?: string | null;
};

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Market value of a row, from the live price where there is one. */
export function valueOf(r: Row): number | null {
  const p = num(r.price);
  if (p != null) return p * r.qty;
  return num(r.value);
}

/** Unrealised P&L of a row. */
export function pnlOf(r: Row): number | null {
  const p = num(r.price);
  if (p != null) return (p - r.cost) * r.qty;
  return num(r.pnl);
}

// ── contribution to P&L ───────────────────────────────────────────────────

export type Contribution = {
  ticker: string;
  sector: string | null;
  pnl: number;
  /** Share of the book's total ABSOLUTE P&L movement, 0–100. */
  sharePct: number;
  /** P&L as a percentage of the book's cost basis — the honest "it moved the
   *  book by this much" figure. */
  bookPct: number | null;
  pnlPct: number | null;
  weightPct: number | null;
};

export type Attribution = {
  rows: Contribution[];
  winners: Contribution[];
  losers: Contribution[];
  totalPnl: number;
  bookCost: number;
  /** How much of the gross P&L movement the single largest contributor is. */
  topSharePct: number | null;
  /** Positions needed to account for half the gross movement. */
  halfCount: number | null;
  priced: number;
  total: number;
};

/**
 * Which positions moved the book.
 *
 * Share is computed against the sum of ABSOLUTE P&L, not the net. Against the
 * net it is unbounded and meaningless: a book that is +100 net from a +1000
 * winner and a −900 loser would report the winner at 1000% and the loser at
 * −900%, which tells the reader nothing. Against gross movement both come out
 * near 50%, which is the truth — two positions did roughly equal work in
 * opposite directions.
 */
export function attribution(rows: Row[]): Attribution {
  const priced: Contribution[] = [];
  let bookCost = 0;
  for (const r of rows) {
    bookCost += r.cost * r.qty;
    const pnl = pnlOf(r);
    if (pnl == null) continue;
    priced.push({
      ticker: r.ticker,
      sector: r.sector ?? null,
      pnl,
      sharePct: 0,
      bookPct: null,
      pnlPct: num(r.pnl_pct) ?? (r.cost ? ((pnl / (r.cost * r.qty)) * 100) : null),
      weightPct: num(r.weight),
    });
  }
  const gross = priced.reduce((a, c) => a + Math.abs(c.pnl), 0);
  const totalPnl = priced.reduce((a, c) => a + c.pnl, 0);
  for (const c of priced) {
    c.sharePct = gross > 0 ? (Math.abs(c.pnl) / gross) * 100 : 0;
    c.bookPct = bookCost > 0 ? (c.pnl / bookCost) * 100 : null;
  }
  const sorted = [...priced].sort((a, b) => b.pnl - a.pnl);

  // Positions needed to reach half the gross movement, largest first.
  let halfCount: number | null = null;
  if (gross > 0) {
    const byMagnitude = [...priced].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    let acc = 0;
    for (let i = 0; i < byMagnitude.length; i++) {
      acc += Math.abs(byMagnitude[i].pnl);
      if (acc >= gross / 2) { halfCount = i + 1; break; }
    }
  }
  return {
    rows: sorted,
    winners: sorted.filter((c) => c.pnl > 0),
    losers: sorted.filter((c) => c.pnl < 0).reverse(),
    totalPnl,
    bookCost,
    topSharePct: priced.length
      ? Math.max(...priced.map((c) => c.sharePct)) : null,
    halfCount,
    priced: priced.length,
    total: rows.length,
  };
}

/** What the attribution means, including what it excludes. */
export function attributionNote(a: Attribution): string {
  if (!a.priced) {
    return "No position has a price yet, so there is nothing to attribute.";
  }
  const parts: string[] = [];
  if (a.halfCount != null) {
    parts.push(a.halfCount === 1
      ? "A SINGLE position accounts for half of everything this book has done. "
        + "The total P&L is that position's story, not the portfolio's."
      : `${a.halfCount} of ${a.priced} positions account for half of everything `
        + "this book has done.");
  }
  parts.push("Shares are measured against the sum of absolute P&L, not the net: "
    + "against a net figure a winner and an offsetting loser would report 1,000% "
    + "and −900%, which describes nothing.");
  if (a.priced < a.total) {
    parts.push(`${a.total - a.priced} position${a.total - a.priced === 1 ? "" : "s"} `
      + "had no price and are excluded.");
  }
  parts.push("This is unrealised P&L against average cost. It excludes closed "
    + "positions, dividends received, and every cost of trading — so it is not "
    + "your return.");
  return parts.join(" ");
}

// ── concentration ─────────────────────────────────────────────────────────

export type Concentration = {
  /** Herfindahl index over position weights, 0–1. */
  hhi: number | null;
  /** 1/HHI — the number of equal-sized positions this book behaves like. */
  effectiveN: number | null;
  topPct: number | null;
  top3Pct: number | null;
  top5Pct: number | null;
  positions: number;
  band: "concentrated" | "focused" | "diversified" | "unknown";
};

const BANDS = [
  { max: 5, band: "concentrated" as const },
  { max: 15, band: "focused" as const },
  { max: Infinity, band: "diversified" as const },
];

/**
 * How concentrated the book really is.
 *
 * The old screen's only measure was "largest position > 30%". Three positions
 * at 33% each pass that test, and there is no more concentrated equity book
 * than one holding three names. The effective number of positions catches it:
 * that book scores 3.0 and a 40-name book with one 30% holding scores about 8.
 *
 * Weights come from market value, so this is exposure now rather than what was
 * put in.
 */
export function concentration(rows: Row[]): Concentration {
  const values = rows.map(valueOf).filter((v): v is number => v != null && v > 0);
  const total = values.reduce((a, v) => a + v, 0);
  if (!values.length || total <= 0) {
    return { hhi: null, effectiveN: null, topPct: null, top3Pct: null,
      top5Pct: null, positions: rows.length, band: "unknown" };
  }
  const weights = values.map((v) => v / total).sort((a, b) => b - a);
  const hhi = weights.reduce((a, w) => a + w * w, 0);
  const effectiveN = hhi > 0 ? 1 / hhi : null;
  const topN = (n: number) =>
    weights.slice(0, n).reduce((a, w) => a + w, 0) * 100;
  return {
    hhi,
    effectiveN,
    topPct: weights[0] * 100,
    top3Pct: topN(3),
    top5Pct: topN(5),
    positions: values.length,
    band: BANDS.find((b) => (effectiveN ?? 0) <= b.max)!.band,
  };
}

/** Concentration by sector rather than by position. */
export function sectorConcentration(
    sectors: { sector: string; weight: number }[]): Concentration {
  const rows: Row[] = sectors
    .filter((s) => Number.isFinite(s.weight) && s.weight > 0)
    .map((s) => ({ ticker: s.sector, qty: 1, cost: 0, price: s.weight }));
  const c = concentration(rows);
  return { ...c, positions: rows.length };
}

export function concentrationNote(c: Concentration, s: Concentration): string {
  if (c.effectiveN == null) {
    return "No priced positions, so concentration can't be measured.";
  }
  const parts = [
    `${c.positions} positions, but the book behaves like `
      + `${c.effectiveN.toFixed(1)} equal-sized ones — that is what the `
      + "effective count means, and it is the figure a largest-position "
      + "threshold misses. Three holdings at a third each would clear a "
      + "“no position over 30%” rule while being as concentrated as an "
      + "equity book gets.",
  ];
  if (c.band === "concentrated") {
    parts.push("At this level single-name news moves the whole book, and any "
      + "diversification benefit is largely notional.");
  }
  if (s.effectiveN != null && s.effectiveN < 3) {
    parts.push(`Sector exposure is narrower still — the equivalent of `
      + `${s.effectiveN.toFixed(1)} sectors — so the names are likely to fall `
      + "together, which is the failure the position count hides.");
  }
  parts.push("Weights are market value, so this is exposure as it stands rather "
    + "than as it was bought. Correlation between holdings is not measured here: "
    + "twenty names in one industry is one bet, however the count reads.");
  return parts.join(" ");
}

// ── where the risk comes from ─────────────────────────────────────────────

export type BetaSource = {
  ticker: string;
  beta: number;
  weightPct: number;
  /** Points of the book's weighted beta this position supplies. */
  contribution: number;
};

export type BetaBreakdown = {
  rows: BetaSource[];
  /** Weighted beta over the positions that HAVE a beta. */
  weightedBeta: number | null;
  /** Share of book value that carries a beta at all, 0–100. */
  coveragePct: number | null;
  missing: string[];
};

/**
 * Which holdings supply the book's beta.
 *
 * A weighted beta on its own is not actionable — you cannot reduce "1.15". The
 * contribution breakdown is: it says which two positions are supplying most of
 * it, and whether trimming them would change anything.
 *
 * Coverage is reported because a beta computed over 60% of the book and
 * presented as the book's beta is simply wrong, and free providers leave beta
 * blank on plenty of listings.
 */
export function betaBreakdown(rows: Row[]): BetaBreakdown {
  let total = 0;
  const priced: { r: Row; v: number }[] = [];
  for (const r of rows) {
    const v = valueOf(r);
    if (v == null || v <= 0) continue;
    total += v;
    priced.push({ r, v });
  }
  if (!total) {
    return { rows: [], weightedBeta: null, coveragePct: null, missing: [] };
  }
  const withBeta = priced.filter(({ r }) => num(r.beta) != null);
  const covered = withBeta.reduce((a, { v }) => a + v, 0);
  const out: BetaSource[] = withBeta.map(({ r, v }) => ({
    ticker: r.ticker,
    beta: num(r.beta)!,
    weightPct: (v / total) * 100,
    contribution: (v / total) * num(r.beta)!,
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return {
    rows: out,
    // Normalised over what is COVERED, not over the whole book: dividing by
    // total value would silently understate beta in proportion to how many
    // holdings the provider left blank.
    weightedBeta: covered > 0
      ? withBeta.reduce((a, { r, v }) => a + (v / covered) * num(r.beta)!, 0) : null,
    coveragePct: (covered / total) * 100,
    missing: priced.filter(({ r }) => num(r.beta) == null).map(({ r }) => r.ticker),
  };
}

export function betaNote(b: BetaBreakdown): string {
  if (b.weightedBeta == null) {
    return "No holding carries a beta from the providers, so the book's market "
      + "sensitivity can't be estimated.";
  }
  const parts = [
    `Weighted beta of ${b.weightedBeta.toFixed(2)}, normalised over the holdings `
      + "that actually have one rather than over the whole book — dividing by "
      + "total value would understate it in proportion to how many are blank.",
  ];
  if (b.coveragePct != null && b.coveragePct < 90) {
    parts.push(`Only ${b.coveragePct.toFixed(0)}% of book value carries a beta`
      + (b.missing.length <= 4 && b.missing.length
        ? ` (missing: ${b.missing.join(", ")}).` : "."));
  }
  if (b.rows.length >= 2) {
    const [a1, a2] = b.rows;
    parts.push(`${a1.ticker} and ${a2.ticker} supply the most of it — `
      + `${(a1.contribution + a2.contribution).toFixed(2)} of the ${b.weightedBeta.toFixed(2)} `
      + "between them, which is the part you could actually act on.");
  }
  parts.push("Each beta is a backward-looking regression against whichever index "
    + "the provider chose, over whichever window it chose. Betas also rise "
    + "together in a selloff, so this understates how the book behaves in "
    + "exactly the conditions it is being consulted about.");
  return parts.join(" ");
}

// ── the history line ──────────────────────────────────────────────────────

export type Point = { date: string; value: number; cost: number };

export type HistoryStats = {
  days: number;
  /** Value over cost at the latest point, in percent. */
  returnPct: number | null;
  /** Deepest peak-to-trough fall in book VALUE, in percent (negative). */
  maxDrawdownPct: number | null;
  bestDayPct: number | null;
  worstDayPct: number | null;
  from: string | null;
  to: string | null;
};

/**
 * The shape of the ride, from the value/cost series.
 *
 * Note what this is NOT: a time-weighted return. The series records book value
 * against cost basis, and both jump when a position is added — so a rise from
 * adding money is indistinguishable from a rise from performance. Anything
 * computed here inherits that, which the note says plainly rather than
 * dressing the number up as a return.
 */
export function historyStats(points: Point[]): HistoryStats {
  const empty: HistoryStats = {
    days: points.length, returnPct: null, maxDrawdownPct: null,
    bestDayPct: null, worstDayPct: null, from: null, to: null,
  };
  if (points.length < 2) return empty;
  const last = points[points.length - 1];

  let peak = points[0].value, worst = 0;
  let best: number | null = null, worstDay: number | null = null;
  for (let i = 0; i < points.length; i++) {
    const v = points[i].value;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (v / peak - 1) * 100;
      if (dd < worst) worst = dd;
    }
    if (i > 0) {
      const prev = points[i - 1].value;
      if (prev > 0) {
        const chg = (v / prev - 1) * 100;
        if (best == null || chg > best) best = chg;
        if (worstDay == null || chg < worstDay) worstDay = chg;
      }
    }
  }
  return {
    days: points.length,
    returnPct: last.cost > 0 ? ((last.value / last.cost) - 1) * 100 : null,
    maxDrawdownPct: worst,
    bestDayPct: best,
    worstDayPct: worstDay,
    from: points[0].date,
    to: last.date,
  };
}

export function historyNote(s: HistoryStats): string {
  if (s.days < 2) {
    return "History accrues one point per day you open this screen, so there is "
      + "not enough of it to measure yet. It is also not a market-hours record — "
      + "a day you didn't visit leaves no point.";
  }
  const parts = [
    `${s.days} recorded points, ${s.from} to ${s.to}.`,
  ];
  if (s.maxDrawdownPct != null && s.maxDrawdownPct < -10) {
    parts.push(`The deepest fall from a high was ${s.maxDrawdownPct.toFixed(1)}%, `
      + "which is what holding this actually felt like — a P&L figure hides it.");
  }
  parts.push("These are NOT time-weighted returns. The series records book value "
    + "against cost basis, and both step up when you add a position, so growth "
    + "from contributing money is indistinguishable from growth from "
    + "performance. Points are recorded only on days you opened the screen, so "
    + "gaps are missing observations rather than flat markets.");
  return parts.join(" ");
}

// ── sorting the holdings table ────────────────────────────────────────────

export type SortKey = "ticker" | "qty" | "cost" | "price" | "value" | "pnl"
  | "pnl_pct" | "day_pnl" | "weight";

/** Sort holdings, with nulls always last regardless of direction — a row with
 *  no price is not "the smallest", it is unknown, and floating it to the top
 *  of an ascending sort buries the rows that matter. */
export function sortRows(rows: Row[], key: SortKey, dir: "asc" | "desc"): Row[] {
  const value = (r: Row): number | string | null => {
    switch (key) {
      case "ticker": return r.ticker;
      case "qty": return r.qty;
      case "cost": return r.cost;
      case "price": return num(r.price);
      case "value": return valueOf(r);
      case "pnl": return pnlOf(r);
      case "pnl_pct": return num(r.pnl_pct);
      case "day_pnl": return num(r.day_pnl);
      case "weight": return num(r.weight);
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a), vb = value(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" || typeof vb === "string") {
      return String(va).localeCompare(String(vb)) * sign;
    }
    return (va - vb) * sign;
  });
}
