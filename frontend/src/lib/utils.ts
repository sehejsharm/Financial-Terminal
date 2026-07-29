import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function humanNumber(n: number | null | undefined, prefix = ""): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const map: [number, string][] = [
    [1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"],
  ];
  for (const [div, suf] of map) {
    // The threshold is nudged below the divisor so a value that ROUNDS to the
    // next unit is shown in it: 999,999,999 formatted naively reads
    // "1000.00M", a unit nobody uses, sitting next to a "$1.00B" three rows
    // above. Two decimals means the cut is at 0.999995 of the divisor.
    if (abs >= div * 0.999995) {
      return `${sign}${prefix}${(abs / div).toFixed(2)}${suf}`;
    }
  }
  return `${sign}${prefix}${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Signed percent — ONLY for genuine change/delta values (price change,
 *  indicator change). Level metrics (yield, ROE, margin) must use
 *  formatPercent, which never fakes a "+" direction on a static level. */
export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  // Clamp values that ROUND to zero so tiles never show "-0.00%" (negative
  // zero) or a misleading "+0.00%" — both render as a plain "0.00%".
  const rounded = Number(v.toFixed(digits));
  if (rounded === 0) return `${(0).toFixed(digits)}%`;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(digits)}%`;
}

/** Canonical unsigned percent formatter for LEVEL metrics.
 *  `fraction: true` converts 0.51 -> "51.00%" (providers frequently store
 *  percent-like fields as decimals — the off-by-100 class of bug). */
export function formatPercent(
  v: number | null | undefined,
  opts: { fraction?: boolean; digits?: number } = {},
): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const { fraction = false, digits = 2 } = opts;
  const pct = fraction ? v * 100 : v;
  const rounded = Number(pct.toFixed(digits));
  // Number(...) normalises -0 to a comparable 0; render without the "-".
  return `${(rounded === 0 ? 0 : rounded).toFixed(digits)}%`;
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const CUR_SYMBOLS: Record<string, string> = {
  INR: "₹", USD: "$", EUR: "€", GBP: "£", JPY: "¥",
  CNY: "¥", HKD: "HK$", AUD: "A$", CAD: "C$", SGD: "S$",
};

/** Infer currency from a ticker suffix when the provider doesn't tell us. */
const SUFFIX_CCY: Record<string, string> = {
  NS: "INR", BO: "INR", BSE: "INR", NSE: "INR",
  L: "GBP", LON: "GBP",
  PA: "EUR", DE: "EUR", AS: "EUR", MI: "EUR", MC: "EUR", BR: "EUR", LS: "EUR", VI: "EUR",
  SW: "CHF", TO: "CAD", V: "CAD",
  HK: "HKD", T: "JPY", JT: "JPY",
  SS: "CNY", SZ: "CNY", SI: "SGD", AX: "AUD",
};

export function inferCurrency(ticker: string | undefined, fallback?: string | null): string {
  if (fallback && fallback !== "USD") return fallback;
  if (!ticker) return fallback || "USD";
  const t = ticker.toUpperCase();
  // Index/futures specials.
  if (t === "^NSEI" || t === "^BSESN" || t === "^NSEBANK" || t === "^INDIAVIX") return "INR";
  if (t === "INR=X") return "INR";
  if (t.startsWith("GC=") || t.startsWith("SI=") || t.startsWith("CL=")) return "USD";
  const i = t.lastIndexOf(".");
  if (i > 0) {
    const suf = t.slice(i + 1);
    if (SUFFIX_CCY[suf]) return SUFFIX_CCY[suf];
  }
  return fallback || "USD";
}

export const curSymbol = (code?: string | null) =>
  code ? CUR_SYMBOLS[code.toUpperCase()] ?? code : "";

/** One-step helper: ticker → symbol. Use this everywhere user-facing.
 *  Index tickers (^NSEI, ^CNX500, …) return "" — index levels are POINTS,
 *  not money; a ₹ / $ prefix on them is simply wrong. Currency symbols are
 *  reserved for actual price / market-cap fields on tradable instruments. */
export const curForTicker = (ticker: string | undefined, providerCcy?: string | null) => {
  if (ticker?.startsWith("^")) return "";
  return curSymbol(inferCurrency(ticker, providerCcy));
};
