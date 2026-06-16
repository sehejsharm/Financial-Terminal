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
    if (abs >= div) return `${sign}${prefix}${(abs / div).toFixed(2)}${suf}`;
  }
  return `${sign}${prefix}${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
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

/** One-step helper: ticker → symbol. Use this everywhere user-facing. */
export const curForTicker = (ticker: string | undefined, providerCcy?: string | null) =>
  curSymbol(inferCurrency(ticker, providerCcy));
