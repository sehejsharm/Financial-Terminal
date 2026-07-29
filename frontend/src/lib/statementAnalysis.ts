/** Turning three statements into an analysis.
 *
 *  The FA screen printed the rows a provider happened to return, in the order
 *  it returned them, with no growth, no margins, no ratios and no way to see
 *  whether the numbers were getting better or worse. That is a data dump, not
 *  a financials screen — the work of reading it was left entirely to the
 *  reader, who then does the same arithmetic by hand every time.
 *
 *  Everything here is pure so the ratio definitions are testable, which
 *  matters more than usual: a current ratio computed off the wrong line item
 *  looks perfectly plausible and is simply wrong.
 *
 *  The hard part is not the arithmetic. It is that our two providers name the
 *  same line differently — FMP says "Revenue" and "Shareholders' Equity",
 *  yfinance says "Total Revenue" and "Stockholders Equity" — so every metric
 *  has to resolve a line by MEANING rather than by label, or the screen shows
 *  full ratios on US names and blanks on Indian ones for no reason a user
 *  could ever discover.
 */

export type StatementRow = Record<string, number | string | null> & { line: string };

export type Statementish = {
  columns: string[];
  rows: StatementRow[];
};

/** Canonical line items, with every label our providers actually emit. */
export const LINE_ALIASES: Record<string, string[]> = {
  revenue: ["Revenue", "Total Revenue", "TotalRevenue", "Operating Revenue"],
  cogs: ["Cost of Revenue", "Cost Of Revenue", "CostOfRevenue"],
  grossProfit: ["Gross Profit", "GrossProfit"],
  opex: ["Operating Expenses", "Operating Expense", "OperatingExpense"],
  operatingIncome: ["Operating Income", "OperatingIncome", "EBIT"],
  ebitda: ["EBITDA", "Normalized EBITDA"],
  pretaxIncome: ["Pre-Tax Income", "Pretax Income", "PretaxIncome",
                 "Income Before Tax"],
  tax: ["Tax Provision", "Income Tax Expense", "TaxProvision"],
  netIncome: ["Net Income", "NetIncome", "Net Income Common Stockholders"],
  eps: ["EPS (diluted)", "Diluted EPS", "DilutedEPS", "Basic EPS"],

  totalAssets: ["Total Assets", "TotalAssets"],
  currentAssets: ["Total Current Assets", "Current Assets", "CurrentAssets"],
  cash: ["Cash & Equivalents", "Cash And Cash Equivalents",
         "CashAndCashEquivalents"],
  inventory: ["Inventory", "Total Inventory"],
  receivables: ["Receivables", "Accounts Receivable", "Net Receivables"],
  currentLiabilities: ["Total Current Liabilities", "Current Liabilities",
                       "CurrentLiabilities"],
  totalLiabilities: ["Total Liabilities", "Total Liabilities Net Minority Interest"],
  totalDebt: ["Total Debt", "TotalDebt"],
  longTermDebt: ["Long Term Debt", "LongTermDebt"],
  equity: ["Shareholders' Equity", "Stockholders Equity", "StockholdersEquity",
           "Total Stockholder Equity", "Common Stock Equity"],
  retainedEarnings: ["Retained Earnings", "RetainedEarnings"],
  payables: ["Accounts Payable", "Payables"],

  operatingCF: ["Operating Cash Flow", "OperatingCashFlow",
                "Net Cash Provided By Operating Activities"],
  capex: ["Capital Expenditure", "CapitalExpenditure"],
  freeCF: ["Free Cash Flow", "FreeCashFlow"],
  dividends: ["Dividends Paid", "Cash Dividends Paid", "DividendsPaid"],
  buybacks: ["Repurchase Of Capital Stock", "Common Stock Repurchased"],
};

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Find a line by meaning, across both providers' vocabularies. */
export function findRow(rows: StatementRow[], key: string): StatementRow | null {
  const aliases = (LINE_ALIASES[key] ?? []).map(norm);
  if (!aliases.length) return null;
  for (const r of rows) {
    if (aliases.includes(norm(r.line))) return r;
  }
  return null;
}

/**
 * Columns sorted oldest → newest.
 *
 * Providers return newest-first, which is right for a table and wrong for
 * every calculation: a growth rate computed over a reversed series has the
 * correct magnitude and the wrong sign, and nothing about the output looks
 * broken.
 */
export function chronological(columns: string[]): string[] {
  return [...columns].sort((a, b) => {
    const ta = Date.parse(a), tb = Date.parse(b);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return a.localeCompare(b);
  });
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A line item as an oldest-first series aligned to `cols`. */
export function seriesFor(st: Statementish | null, key: string,
                          cols?: string[]): (number | null)[] {
  if (!st) return [];
  const columns = cols ?? chronological(st.columns);
  const row = findRow(st.rows, key);
  if (!row) return columns.map(() => null);
  return columns.map((c) => num(row[c]));
}

/** Period-over-period growth, in percent. Null where either side is missing
 *  or the base is zero — an infinite growth rate is not a fact. */
export function yoy(values: (number | null)[]): (number | null)[] {
  return values.map((v, i) => {
    if (i === 0) return null;
    const prev = values[i - 1];
    if (v == null || prev == null || prev === 0) return null;
    // A sign flip makes percentage growth meaningless: -100 to +50 is not
    // "150% growth", it is a swing from loss to profit and needs saying, not
    // a number.
    if (prev < 0 && v >= 0) return null;
    return ((v - prev) / Math.abs(prev)) * 100;
  });
}

/** Compound annual growth between the first and last non-null values. */
export function cagr(values: (number | null)[],
                     periodsPerYear = 1): number | null {
  const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v != null && p.v !== 0);
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  // Negative endpoints make the root undefined or meaningless.
  if (first.v! <= 0 || last.v! <= 0) return null;
  const years = (last.i - first.i) / periodsPerYear;
  if (years <= 0) return null;
  return ((last.v! / first.v!) ** (1 / years) - 1) * 100;
}

function ratio(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

function pctOf(a: number | null, b: number | null): number | null {
  const r = ratio(a, b);
  return r == null ? null : r * 100;
}

export type RatioKey =
  | "grossMargin" | "operatingMargin" | "ebitdaMargin" | "netMargin"
  | "roe" | "roa" | "roce"
  | "currentRatio" | "quickRatio"
  | "debtToEquity" | "netDebtToEbitda" | "interestCover"
  | "assetTurnover" | "fcfMargin" | "fcfConversion" | "capexToSales"
  | "effectiveTax";

export type RatioDef = {
  key: RatioKey;
  label: string;
  /** How it is computed, shown next to the number. */
  formula: string;
  unit: "%" | "x";
  /** Higher is better, lower is better, or neither. */
  direction: "up" | "down" | "none";
  group: "Margins" | "Returns" | "Liquidity" | "Leverage" | "Efficiency & cash";
};

export const RATIOS: RatioDef[] = [
  { key: "grossMargin", label: "Gross margin", formula: "gross profit / revenue", unit: "%", direction: "up", group: "Margins" },
  { key: "operatingMargin", label: "Operating margin", formula: "operating income / revenue", unit: "%", direction: "up", group: "Margins" },
  { key: "ebitdaMargin", label: "EBITDA margin", formula: "EBITDA / revenue", unit: "%", direction: "up", group: "Margins" },
  { key: "netMargin", label: "Net margin", formula: "net income / revenue", unit: "%", direction: "up", group: "Margins" },

  { key: "roe", label: "Return on equity", formula: "net income / shareholders' equity", unit: "%", direction: "up", group: "Returns" },
  { key: "roa", label: "Return on assets", formula: "net income / total assets", unit: "%", direction: "up", group: "Returns" },
  { key: "roce", label: "Return on capital employed", formula: "operating income / (total assets − current liabilities)", unit: "%", direction: "up", group: "Returns" },

  { key: "currentRatio", label: "Current ratio", formula: "current assets / current liabilities", unit: "x", direction: "up", group: "Liquidity" },
  { key: "quickRatio", label: "Quick ratio", formula: "(current assets − inventory) / current liabilities", unit: "x", direction: "up", group: "Liquidity" },

  { key: "debtToEquity", label: "Debt / equity", formula: "total debt / shareholders' equity", unit: "x", direction: "down", group: "Leverage" },
  { key: "netDebtToEbitda", label: "Net debt / EBITDA", formula: "(total debt − cash) / EBITDA", unit: "x", direction: "down", group: "Leverage" },
  { key: "interestCover", label: "Interest cover", formula: "operating income / (operating income − pre-tax income)", unit: "x", direction: "up", group: "Leverage" },

  { key: "assetTurnover", label: "Asset turnover", formula: "revenue / total assets", unit: "x", direction: "up", group: "Efficiency & cash" },
  { key: "fcfMargin", label: "Free cash flow margin", formula: "free cash flow / revenue", unit: "%", direction: "up", group: "Efficiency & cash" },
  { key: "fcfConversion", label: "FCF conversion", formula: "free cash flow / net income", unit: "%", direction: "up", group: "Efficiency & cash" },
  { key: "capexToSales", label: "Capex / sales", formula: "|capex| / revenue", unit: "%", direction: "none", group: "Efficiency & cash" },
  { key: "effectiveTax", label: "Effective tax rate", formula: "tax / pre-tax income", unit: "%", direction: "none", group: "Efficiency & cash" },
];

export type Statements = {
  income: Statementish | null;
  balance: Statementish | null;
  cashflow: Statementish | null;
};

/**
 * Every ratio, as a series across the periods the three statements share.
 *
 * Only periods present in ALL required statements are used: a ratio mixing
 * this year's profit with last year's balance sheet is not a ratio.
 */
export function ratioSeries(st: Statements): {
  columns: string[];
  values: Record<RatioKey, (number | null)[]>;
} {
  const cols = sharedColumns(st);
  const g = (kind: keyof Statements, key: string) => seriesFor(st[kind], key, cols);

  const revenue = g("income", "revenue");
  const gross = g("income", "grossProfit");
  const cogs = g("income", "cogs");
  const opInc = g("income", "operatingIncome");
  const ebitda = g("income", "ebitda");
  const net = g("income", "netIncome");
  const pretax = g("income", "pretaxIncome");
  const tax = g("income", "tax");

  const assets = g("balance", "totalAssets");
  const curAssets = g("balance", "currentAssets");
  const inventory = g("balance", "inventory");
  const curLiab = g("balance", "currentLiabilities");
  const debt = g("balance", "totalDebt");
  const cash = g("balance", "cash");
  const equity = g("balance", "equity");

  const ocf = g("cashflow", "operatingCF");
  const capex = g("cashflow", "capex");
  const fcfRaw = g("cashflow", "freeCF");

  const at = (arr: (number | null)[], i: number) => arr[i] ?? null;

  const values = {} as Record<RatioKey, (number | null)[]>;
  const put = (k: RatioKey, fn: (i: number) => number | null) => {
    values[k] = cols.map((_, i) => fn(i));
  };

  // Gross profit is often absent while revenue and cost of revenue are both
  // present; deriving it is exact, not an estimate.
  const grossAt = (i: number) => at(gross, i)
    ?? (at(revenue, i) != null && at(cogs, i) != null
      ? at(revenue, i)! - at(cogs, i)! : null);
  // Same for free cash flow: operating cash flow plus capex (capex is
  // reported negative by both providers).
  const fcfAt = (i: number) => at(fcfRaw, i)
    ?? (at(ocf, i) != null && at(capex, i) != null
      ? at(ocf, i)! + at(capex, i)! : null);

  put("grossMargin", (i) => pctOf(grossAt(i), at(revenue, i)));
  put("operatingMargin", (i) => pctOf(at(opInc, i), at(revenue, i)));
  put("ebitdaMargin", (i) => pctOf(at(ebitda, i), at(revenue, i)));
  put("netMargin", (i) => pctOf(at(net, i), at(revenue, i)));

  put("roe", (i) => {
    const e = at(equity, i);
    // Negative equity makes return on equity meaningless rather than merely
    // negative — a deficit has no "return on" it.
    return e != null && e > 0 ? pctOf(at(net, i), e) : null;
  });
  put("roa", (i) => pctOf(at(net, i), at(assets, i)));
  put("roce", (i) => {
    const a = at(assets, i), cl = at(curLiab, i);
    if (a == null || cl == null) return null;
    const employed = a - cl;
    return employed > 0 ? pctOf(at(opInc, i), employed) : null;
  });

  put("currentRatio", (i) => ratio(at(curAssets, i), at(curLiab, i)));
  put("quickRatio", (i) => {
    const ca = at(curAssets, i), inv = at(inventory, i), cl = at(curLiab, i);
    if (ca == null || cl == null) return null;
    // Without an inventory line the quick ratio would equal the current
    // ratio, which silently overstates liquidity for anyone holding stock.
    return inv == null ? null : ratio(ca - inv, cl);
  });

  put("debtToEquity", (i) => {
    const e = at(equity, i);
    return e != null && e > 0 ? ratio(at(debt, i), e) : null;
  });
  put("netDebtToEbitda", (i) => {
    const d = at(debt, i), c = at(cash, i), e = at(ebitda, i);
    if (d == null || c == null || e == null || e <= 0) return null;
    return (d - c) / e;
  });
  put("interestCover", (i) => {
    const oi = at(opInc, i), pt = at(pretax, i);
    if (oi == null || pt == null) return null;
    // Interest is not a line either provider gives us, so it is inferred as
    // the gap between operating and pre-tax income. That gap also contains
    // other non-operating items, so this is an approximation and the screen
    // labels it as one.
    const interest = oi - pt;
    return interest > 0 ? oi / interest : null;
  });

  put("assetTurnover", (i) => ratio(at(revenue, i), at(assets, i)));
  put("fcfMargin", (i) => pctOf(fcfAt(i), at(revenue, i)));
  put("fcfConversion", (i) => {
    const n = at(net, i);
    return n != null && n > 0 ? pctOf(fcfAt(i), n) : null;
  });
  put("capexToSales", (i) => {
    const c = at(capex, i);
    return c == null ? null : pctOf(Math.abs(c), at(revenue, i));
  });
  put("effectiveTax", (i) => {
    const pt = at(pretax, i);
    return pt != null && pt > 0 ? pctOf(Math.abs(at(tax, i) ?? NaN), pt) : null;
  });

  return { columns: cols, values };
}

/** Periods present in every statement that has any data at all. */
export function sharedColumns(st: Statements): string[] {
  const sets = (["income", "balance", "cashflow"] as const)
    .map((k) => st[k]?.columns ?? [])
    .filter((c) => c.length > 0);
  if (!sets.length) return [];
  const shared = sets.reduce((acc, cur) => acc.filter((c) => cur.includes(c)));
  return chronological(shared);
}

export type Flag = {
  level: "warn" | "note";
  title: string;
  detail: string;
};

/**
 * Earnings-quality checks.
 *
 * Deliberately a short list of things that are checkable from three
 * statements and that a reader would want flagged rather than left to
 * notice: profit the business isn't converting into cash, margins going the
 * wrong way, leverage rising, and a tax rate that isn't repeatable.
 *
 * Every flag needs at least three periods. Two points is a line, not a
 * trend, and flagging on one comparison produces noise that trains people
 * to ignore the panel.
 */
export function qualityFlags(st: Statements): Flag[] {
  const { columns, values } = ratioSeries(st);
  const out: Flag[] = [];
  if (columns.length < 3) return out;

  const last = <T,>(a: T[]) => a[a.length - 1];
  const recent = (arr: (number | null)[], n = 3) =>
    arr.slice(-n).filter((v): v is number => v != null);

  const fcfConv = recent(values.fcfConversion);
  if (fcfConv.length >= 3 && fcfConv.every((v) => v < 80)) {
    out.push({
      level: "warn",
      title: "Profit is not converting into cash",
      detail: `Free cash flow has been under 80% of net income in each of the `
        + `last ${fcfConv.length} periods (most recent ${fcfConv[fcfConv.length - 1].toFixed(0)}%). `
        + "That gap is normal for a company investing heavily and a warning "
        + "sign when it isn't — check capex and working capital before "
        + "deciding which.",
    });
  }

  const gm = recent(values.grossMargin, 3);
  if (gm.length === 3 && gm[2] < gm[0] - 2) {
    out.push({
      level: "warn",
      title: "Gross margin is compressing",
      detail: `Down from ${gm[0].toFixed(1)}% to ${gm[2].toFixed(1)}% over three `
        + "periods. Either input costs are rising faster than pricing, or mix "
        + "is shifting — the statements alone cannot tell you which.",
    });
  }

  const de = recent(values.debtToEquity, 3);
  if (de.length === 3 && de[2] > de[0] * 1.3 && de[2] > 1) {
    out.push({
      level: "warn",
      title: "Leverage is rising",
      detail: `Debt to equity has gone from ${de[0].toFixed(2)}x to `
        + `${de[2].toFixed(2)}x. Rising leverage is a choice, not a problem in `
        + "itself — read it against interest cover and what the borrowing "
        + "funded.",
    });
  }

  const cr = last(values.currentRatio);
  if (cr != null && cr < 1) {
    out.push({
      level: "warn",
      title: "Current liabilities exceed current assets",
      detail: `Current ratio of ${cr.toFixed(2)}x. Routine for businesses that `
        + "collect before they pay (retail, subscriptions) and a genuine "
        + "liquidity question for anyone else.",
    });
  }

  const tax = recent(values.effectiveTax, 3);
  if (tax.length >= 2 && tax[tax.length - 1] < 10) {
    out.push({
      level: "note",
      title: "Unusually low effective tax rate",
      detail: `${tax[tax.length - 1].toFixed(1)}% in the latest period. Often a `
        + "one-off — a credit, a settlement, or losses carried forward — so "
        + "earnings growth flattered by it may not repeat.",
    });
  }

  const ic = last(values.interestCover);
  if (ic != null && ic < 3) {
    out.push({
      level: "warn",
      title: "Thin interest cover",
      detail: `Operating income covers inferred interest ${ic.toFixed(1)}x. `
        + "Inferred from the gap between operating and pre-tax income, which "
        + "also contains other non-operating items — treat it as approximate "
        + "and check the filing.",
    });
  }

  return out;
}

/** Everything the header of an FA screen should say in one line. */
export function coverageNote(st: Statements): string {
  const cols = sharedColumns(st);
  const have = (["income", "balance", "cashflow"] as const)
    .filter((k) => (st[k]?.rows.length ?? 0) > 0);
  if (!have.length) return "No statements available for this listing.";
  if (!cols.length) {
    return `${have.join(", ")} available, but no period appears in all of them — `
      + "ratios that span statements can't be computed.";
  }
  return `${cols.length} period${cols.length === 1 ? "" : "s"} common to `
    + `${have.length} statement${have.length === 1 ? "" : "s"}. Ratios use only `
    + "those, so a year present in one statement and missing from another is "
    + "left out rather than mixed with a neighbouring period.";
}


// ── capital structure ───────────────────────────────────────────────────

/**
 * Diluted share count implied by net income and diluted EPS.
 *
 * Both providers give EPS and net income; neither gives a share-count SERIES,
 * and the count is what tells you whether shareholders are being diluted or
 * bought back. Dividing one by the other recovers it exactly — this is
 * arithmetic on reported figures, not an estimate.
 *
 * Null wherever EPS is zero or missing: an implied count from a rounding
 * artefact is a wild number that would dominate any trend drawn through it.
 */
export function impliedShares(income: Statementish | null,
                              cols?: string[]): (number | null)[] {
  const columns = cols ?? (income ? chronological(income.columns) : []);
  const net = seriesFor(income, "netIncome", columns);
  const eps = seriesFor(income, "eps", columns);
  return columns.map((_, i) => {
    const n = net[i], e = eps[i];
    if (n == null || e == null || e === 0) return null;
    const shares = n / e;
    return shares > 0 ? shares : null;
  });
}

export type EvMultiples = {
  ev: number | null;
  evEbitda: number | null;
  evSales: number | null;
  evFcf: number | null;
  netDebtToEv: number | null;
};

/**
 * Enterprise-value multiples off the latest reported period.
 *
 * EV/EBITDA and EV/sales are the two comparisons that survive different
 * capital structures, which is the whole reason to look at enterprise value
 * rather than market cap. Each returns null rather than a number when its
 * denominator is missing or non-positive — a negative EBITDA produces a
 * negative multiple that reads like a cheap valuation.
 */
export function evMultiples(
  cap: { market_cap?: number | null; total_debt?: number | null; cash?: number | null },
  st: Statements,
): EvMultiples {
  const mcap = cap.market_cap ?? null;
  const debt = cap.total_debt ?? null;
  const cash = cap.cash ?? null;
  const ev = mcap == null ? null : mcap + (debt ?? 0) - (cash ?? 0);
  const cols = sharedColumns(st);
  const latest = (kind: keyof Statements, key: string) => {
    const s = seriesFor(st[kind], key, cols.length ? cols : undefined);
    return [...s].reverse().find((v) => v != null) ?? null;
  };
  const ebitda = latest("income", "ebitda");
  const revenue = latest("income", "revenue");
  let fcf = latest("cashflow", "freeCF");
  if (fcf == null) {
    const ocf = latest("cashflow", "operatingCF");
    const capex = latest("cashflow", "capex");
    fcf = ocf != null && capex != null ? ocf + capex : null;
  }
  const over = (d: number | null) =>
    (ev == null || d == null || d <= 0 ? null : ev / d);
  return {
    ev,
    evEbitda: over(ebitda),
    evSales: over(revenue),
    evFcf: over(fcf),
    netDebtToEv: ev && ev > 0 && debt != null
      ? ((debt - (cash ?? 0)) / ev) * 100 : null,
  };
}
