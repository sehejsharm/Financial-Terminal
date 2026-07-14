/**
 * Shared label humanizer — the single place backend field names become
 * user-facing text. Raw camelCase identifiers ("insidersPercentHeld",
 * "yearAgoEps") and yfinance period codes ("0q", "+1q") were leaking
 * straight into table headers and row labels across Estimates, Ownership,
 * and every FrameTable; route ALL such strings through prettyLabel().
 */

// Exact-match replacements (checked case-insensitively) — period codes and
// terms whose auto-split form would read wrong.
const EXACT: Record<string, string> = {
  "0q": "Current Qtr",
  "+1q": "Next Qtr",
  "-1q": "Last Qtr",
  "0y": "Current FY",
  "+1y": "Next FY",
  "-1y": "Last FY",
  "+5y": "Next 5 Years",
  "-5y": "Past 5 Years",
  pe: "P/E",
  eps: "EPS",
  ev: "EV",
  ebitda: "EBITDA",
  roe: "ROE",
  roce: "ROCE",
  roa: "ROA",
  peg: "PEG",
  de: "D/E",
  mcap_cr: "Mkt Cap (₹ cr)",
  wacc: "WACC",
};

// Word-level fixes applied after splitting camelCase/snake_case.
const WORD: Record<string, string> = {
  eps: "EPS", pe: "P/E", ebitda: "EBITDA", ev: "EV", roe: "ROE",
  roce: "ROCE", roa: "ROA", peg: "PEG", pct: "%", fy: "FY", yoy: "YoY",
  ttm: "TTM", avg: "Avg", num: "No.", id: "ID", url: "URL", ipo: "IPO",
  etf: "ETF", nse: "NSE", bse: "BSE", fii: "FII", dii: "DII",
};

function titleWord(w: string): string {
  const lower = w.toLowerCase();
  if (WORD[lower]) return WORD[lower];
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** "insidersPercentHeld" -> "Insiders Percent Held"; "0q" -> "Current Qtr";
 *  "year_ago_eps" -> "Year Ago EPS". Leaves normal prose alone. */
export function prettyLabel(raw: string | null | undefined): string {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s) return "";
  const exact = EXACT[s.toLowerCase()];
  if (exact) return exact;
  // Only transform identifier-looking strings; real prose passes through.
  if (!/^[+\-]?[A-Za-z0-9_%./]+$/.test(s)) return s;
  const words = s
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return s;
  return words.map(titleWord).join(" ");
}

/** True when a header/label suggests the column holds percent values. */
export function looksPercentLabel(label: string): boolean {
  return /percent|pct|%|held|yield|growth|margin|change/i.test(label);
}

/** True for identifier-looking camelCase strings safe to prettify in CELLS
 *  (never mangles real names like "Vanguard Group Inc"). */
export function isIdentifierish(v: string): boolean {
  return /^[a-z]+([A-Z][a-z0-9]*)+$/.test(v) || /^[a-z]+(_[a-z0-9]+)+$/.test(v);
}
