/** The terminal's function registry.
 *
 *  Every screen the terminal can show, with the mnemonic you type to reach it.
 *  Kept as data (and pure helpers) so the rail, the keyboard handling, the
 *  ⌘K palette and the URL sync all agree on one list instead of each carrying
 *  its own copy.
 *
 *  Labels are the wire format — they appear in `?fn=` and in saved links — so
 *  they must not be renamed casually. The CODE is the stable thing a user
 *  learns and types.
 */

export type FnGroup = "overview" | "fundamentals" | "market" | "risk" | "research";

export type TerminalFn = {
  /** The label used in the URL and in state. */
  label: string;
  /** Mnemonic, Bloomberg-style. Typed into the ticker box to jump. */
  code: string;
  group: FnGroup;
  /** One line, shown on hover and in the palette. */
  hint: string;
};

export const TERMINAL_FUNCTIONS: TerminalFn[] = [
  { label: "Snapshot", code: "DES", group: "overview",
    hint: "Company description — price, valuation, key ratios, chart" },
  { label: "Technicals & charts", code: "GIP", group: "overview",
    hint: "Full-height price chart with indicators and period switching" },

  { label: "Financials", code: "FA", group: "fundamentals",
    hint: "Income statement, balance sheet and cash flow" },
  { label: "Estimates & targets", code: "EE", group: "fundamentals",
    hint: "Analyst estimates and price targets" },
  { label: "Capital structure", code: "CS", group: "fundamentals",
    hint: "Debt, cash, market cap and share count" },
  { label: "Debt profile", code: "DDIS", group: "fundamentals",
    hint: "Leverage, coverage and the maturity picture" },
  { label: "Earnings history", code: "ERN", group: "fundamentals",
    hint: "Reported vs expected, and the surprise history" },

  { label: "Comparables", code: "CF", group: "market",
    hint: "Peer multiples side by side" },
  { label: "Street ratings", code: "ANR", group: "market",
    hint: "Analyst recommendations and the target spread" },
  { label: "Ownership / insiders", code: "OWN", group: "market",
    hint: "Institutional and insider holdings" },
  { label: "Options & Greeks", code: "OMON", group: "market",
    hint: "Option chain, Greeks, and the strategy builder" },

  { label: "WACC model", code: "WACC", group: "risk",
    hint: "Cost of capital with editable assumptions" },

  { label: "Value-chain map", code: "SPLC", group: "research",
    hint: "Suppliers, customers and competitors" },
  { label: "AI deep-dive", code: "AI", group: "research",
    hint: "Bull/bear case and a deeper written analysis" },
  { label: "Recent news", code: "CN", group: "research",
    hint: "Headlines for this name" },
  { label: "Notes", code: "NT", group: "research",
    hint: "Your own notes on this name" },
];

export const GROUP_LABELS: Record<FnGroup, string> = {
  overview: "Overview",
  fundamentals: "Fundamentals",
  market: "Market",
  risk: "Risk",
  research: "Research",
};

export const GROUP_ORDER: FnGroup[] = [
  "overview", "fundamentals", "market", "risk", "research",
];

export const FN_LABELS: string[] = TERMINAL_FUNCTIONS.map((f) => f.label);

const BY_LABEL = new Map(TERMINAL_FUNCTIONS.map((f) => [f.label, f]));
const BY_CODE = new Map(TERMINAL_FUNCTIONS.map((f) => [f.code, f]));

export function fnByLabel(label: string): TerminalFn | undefined {
  return BY_LABEL.get(label);
}

export function fnByCode(code: string): TerminalFn | undefined {
  return BY_CODE.get((code || "").trim().toUpperCase());
}

export function isFnLabel(x: string): boolean {
  return BY_LABEL.has(x);
}

/**
 * Resolve whatever arrived in `?fn=` — a mnemonic ("des") or a full label
 * ("Snapshot") — to a canonical label. Null when it's neither, so the caller
 * can leave the current view alone rather than blanking the page.
 */
export function resolveFn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (BY_LABEL.has(s)) return s;
  const byCode = BY_CODE.get(s.toUpperCase());
  return byCode ? byCode.label : null;
}

/** Cycle through functions in rail order — drives the [ and ] shortcuts. */
export function stepFn(current: string, dir: -1 | 1): string {
  const ordered = functionsInRailOrder();
  const i = ordered.findIndex((f) => f.label === current);
  if (i < 0) return ordered[0].label;
  // Wraps deliberately: cycling past the end should continue, not dead-end.
  const j = (i + dir + ordered.length) % ordered.length;
  return ordered[j].label;
}

/** Grouped, in the order the rail renders them. */
export function groupedFunctions(): [FnGroup, TerminalFn[]][] {
  return GROUP_ORDER
    .map((g) => [g, TERMINAL_FUNCTIONS.filter((f) => f.group === g)] as [FnGroup, TerminalFn[]])
    .filter(([, list]) => list.length > 0);
}

export function functionsInRailOrder(): TerminalFn[] {
  return groupedFunctions().flatMap(([, list]) => list);
}

/**
 * Interpret what the user typed into the ticker box.
 *
 * A terminal's command line does double duty: "TCS.NS" navigates, "FA" jumps
 * to financials on the current name, and "TCS.NS FA" does both at once. The
 * ambiguity is real — "CS" is both a mnemonic and a plausible ticker — so a
 * bare token is treated as a FUNCTION only when it exactly matches a known
 * mnemonic, and the UI shows what it resolved to.
 */
export type ParsedEntry =
  | { kind: "symbol"; symbol: string }
  | { kind: "function"; fn: string }
  | { kind: "both"; symbol: string; fn: string }
  | { kind: "empty" };

export function parseEntry(raw: string): ParsedEntry {
  const tokens = (raw || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { kind: "empty" };

  if (tokens.length === 1) {
    const fn = fnByCode(tokens[0]);
    return fn ? { kind: "function", fn: fn.label }
              : { kind: "symbol", symbol: tokens[0] };
  }

  // "TICKER CODE" — last token wins as the function when it's a mnemonic.
  const last = fnByCode(tokens[tokens.length - 1]);
  if (last) {
    return { kind: "both", symbol: tokens.slice(0, -1).join(" "), fn: last.label };
  }
  return { kind: "symbol", symbol: tokens[0] };
}
