/** Showing what the model was told.
 *
 *  The AI screen printed a confident narrative and nothing else. There was no
 *  way to check any of it: a sentence about margin compression reads identically
 *  whether the model was handed a margin series, a single figure, or nothing at
 *  all. An analysis whose inputs are hidden is unfalsifiable, and unfalsifiable
 *  output is exactly what a language model is best at producing.
 *
 *  So the backend now returns the figures it passed, and this groups and labels
 *  them for display — including, crucially, naming the important fields that
 *  were MISSING, because a confident claim written off an absent field is the
 *  failure mode a reader most needs to catch.
 */

export type InputRow = { key: string; label: string; value: string };
export type InputGroup = { group: string; rows: InputRow[] };

const LABELS: Record<string, string> = {
  market_cap: "Market cap",
  enterprise_value: "Enterprise value",
  price: "Price",
  trailing_pe: "P/E (trailing)",
  forward_pe: "P/E (forward)",
  price_to_book: "Price / book",
  price_to_sales: "Price / sales",
  ev_to_ebitda: "EV / EBITDA",
  dividend_yield: "Dividend yield",
  revenue: "Revenue",
  ebitda: "EBITDA",
  free_cashflow: "Free cash flow",
  revenue_growth: "Revenue growth",
  earnings_growth: "Earnings growth",
  profit_margin: "Profit margin",
  operating_margin: "Operating margin",
  gross_margin: "Gross margin",
  roe: "Return on equity",
  roa: "Return on assets",
  roce: "Return on capital employed",
  total_debt: "Total debt",
  total_cash: "Cash",
  debt_to_equity: "Debt / equity",
  current_ratio: "Current ratio",
  quick_ratio: "Quick ratio",
  beta: "Beta",
  fifty_two_high: "52-week high",
  fifty_two_low: "52-week low",
  shares_outstanding: "Shares outstanding",
  avg_volume: "Average volume",
  volume: "Volume",
  held_insiders: "Held by insiders",
  held_institutions: "Held by institutions",
  sector: "Sector",
  industry: "Industry",
  employees: "Employees",
};

/** Which group a field belongs in, checked in order. */
const GROUPS: ReadonlyArray<{ group: string; keys: readonly string[] }> = [
  { group: "Size & valuation", keys: ["market_cap", "enterprise_value", "price",
    "trailing_pe", "forward_pe", "price_to_book", "price_to_sales",
    "ev_to_ebitda", "dividend_yield"] },
  { group: "Scale & growth", keys: ["revenue", "ebitda", "free_cashflow",
    "revenue_growth", "earnings_growth"] },
  { group: "Returns & margins", keys: ["profit_margin", "operating_margin",
    "gross_margin", "roe", "roa", "roce"] },
  { group: "Balance sheet", keys: ["total_debt", "total_cash", "debt_to_equity",
    "current_ratio", "quick_ratio"] },
  { group: "Market & ownership", keys: ["beta", "fifty_two_high", "fifty_two_low",
    "shares_outstanding", "avg_volume", "volume", "held_insiders",
    "held_institutions"] },
];

export function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key];
  // An unmapped key is still worth showing — the alternative is hiding an
  // input, which is the thing this whole module exists to prevent.
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * The inputs, grouped the way the fundamentals screens group them.
 *
 * Anything unrecognised lands in "Other" rather than being dropped: an input
 * the display doesn't know about is still an input the model saw.
 */
export function groupInputs(
    inputs: Record<string, string | number> | null | undefined): InputGroup[] {
  if (!inputs) return [];
  const seen = new Set<string>();
  const out: InputGroup[] = [];

  for (const g of GROUPS) {
    const rows: InputRow[] = [];
    for (const k of g.keys) {
      const v = inputs[k];
      if (v == null || v === "") continue;
      seen.add(k);
      rows.push({ key: k, label: labelFor(k), value: String(v) });
    }
    if (rows.length) out.push({ group: g.group, rows });
  }

  const rest = Object.keys(inputs)
    .filter((k) => !seen.has(k) && inputs[k] != null && inputs[k] !== "")
    .sort();
  if (rest.length) {
    out.push({
      group: "Other",
      rows: rest.map((k) => ({ key: k, label: labelFor(k), value: String(inputs[k]) })),
    });
  }
  return out;
}

/**
 * The fields an equity analysis really ought to have had, and didn't.
 *
 * This is the important half. A model given no margin will still write a
 * paragraph about profitability, and the paragraph will be plausible. Naming
 * the gap is the only thing that lets a reader discount it.
 */
export const EXPECTED_FIELDS = [
  "market_cap", "trailing_pe", "revenue", "profit_margin", "roe",
  "debt_to_equity", "free_cashflow", "revenue_growth",
] as const;

export function missingInputs(
    inputs: Record<string, string | number> | null | undefined): string[] {
  if (!inputs) return [];
  return EXPECTED_FIELDS.filter((k) => inputs[k] == null || inputs[k] === "")
    .map(labelFor);
}

/** How many figures the model had to work with. */
export function inputCount(
    inputs: Record<string, string | number> | null | undefined): number {
  if (!inputs) return 0;
  return Object.values(inputs).filter((v) => v != null && v !== "").length;
}

/** The plain-language caveat, naming the gaps. */
export function inputsNote(
    inputs: Record<string, string | number> | null | undefined): string {
  const n = inputCount(inputs);
  if (!n) {
    return "The backend did not report which figures were passed to the model, "
      + "so nothing in the analysis can be checked against its inputs. Treat "
      + "every number in the prose as unverified.";
  }
  const missing = missingInputs(inputs);
  const parts = [
    `These are the ${n} figures the model was given — the whole of what it knew `
      + "about this company beyond its own training. If a number in the prose "
      + "isn't here, the model produced it rather than read it.",
  ];
  if (missing.length) {
    parts.push(`It did NOT have: ${missing.join(", ")}. A model with no margin `
      + "figure will still write a paragraph about profitability, and the "
      + "paragraph will be plausible — discount anything the analysis says "
      + "about these.");
  }
  parts.push("The figures themselves come from the same free providers as the "
    + "rest of the app, so an error upstream becomes a confident sentence here.");
  return parts.join(" ");
}
