/** Bloomberg-style function mnemonics for the ⌘K command line.
 *  `RELIANCE.NS DES` jumps straight to the Snapshot function; multi-ticker
 *  `RELIANCE TCS INFY CF` opens a side-by-side comparables matrix. */

export const FN_CODES: Record<string, string> = {
  DES: "Snapshot",
  GIP: "Technicals & charts",
  FA: "Financials",
  EE: "Estimates & targets",
  CS: "Capital structure",
  CF: "Comparables",
  DDIS: "Debt profile",
  OWN: "Ownership / insiders",
  ERN: "Earnings history",
  ANR: "Street ratings",
  WACC: "WACC model",
  SPLC: "Value-chain map",
  OMON: "Options & Greeks",
  AI: "AI deep-dive",
  CN: "Recent news",
  NT: "Notes",
};

export type ParsedCommand = {
  tickers: string[];
  code: string;
  fnLabel: string;
  href: string;
};

/** Bare NSE-style names get .NS so `RELIANCE TCS CF` works without suffixes;
 *  anything with a dot, caret, or that looks like a US symbol passes through. */
function normalizeTicker(t: string): string {
  const up = t.toUpperCase();
  if (up.includes(".") || up.startsWith("^")) return up;
  // Heuristic: <=4-letter all-alpha reads as a US symbol (AAPL, SPY);
  // longer bare names are almost always NSE listings (RELIANCE, HDFCBANK).
  return up.length <= 4 ? up : `${up}.NS`;
}

/** "RELIANCE.NS DES" / "RELIANCE TCS INFY CF" -> parsed command, or null. */
export function parseCommand(q: string): ParsedCommand | null {
  const tokens = q.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const code = tokens[tokens.length - 1].toUpperCase();
  const fnLabel = FN_CODES[code];
  if (!fnLabel) return null;
  const tickers = tokens.slice(0, -1).map(normalizeTicker);
  if (!tickers.length || tickers.some((t) => !/^[\^A-Z0-9.&\-]+$/.test(t))) return null;

  const first = tickers[0];
  // peers is consumed by the Comparables function (CF) — harmless elsewhere.
  let href = `/terminal?t=${encodeURIComponent(first)}&fn=${code}`;
  if (tickers.length > 1) {
    href += `&peers=${encodeURIComponent(tickers.slice(1).join(","))}`;
  }
  return { tickers, code, fnLabel, href };
}
