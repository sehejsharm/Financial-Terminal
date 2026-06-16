/**
 * Thin fetch wrapper for the Motherboard API.
 *
 * - JWT is stored in a non-HttpOnly cookie so client components can read it.
 *   (A cleaner pattern for production is server actions + HttpOnly cookies.
 *   See docs/enterprise-migration-plan.md Phase 4.)
 * - `apiFetch` throws ApiError on non-2xx for predictable error handling.
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const TOKEN_COOKIE = "mb_token";

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail || `API error ${status}`);
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name: string, value: string, days = 7) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie =
    `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; samesite=lax`;
}

function clearCookie(name: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

export const token = {
  get: () => readCookie(TOKEN_COOKIE),
  set: (v: string) => writeCookie(TOKEN_COOKIE, v),
  clear: () => clearCookie(TOKEN_COOKIE),
};

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const tk = token.get();
  if (tk) headers.set("Authorization", `Bearer ${tk}`);

  const res = await fetch(`${API_URL}${path}`, { ...init, headers, cache: "no-store" });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = (body?.detail || body?.message || detail) as string;
    } catch { /* not JSON */ }
    if (res.status === 401) token.clear();
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── typed call helpers ────────────────────────────────────────────────────
export type Quote = {
  symbol: string; price: number | null; prev_close: number | null;
  change_pct: number | null; currency?: string | null;
};
export type Snapshot = Record<string, unknown> & {
  name?: string; sector?: string; industry?: string;
  market_cap?: number; trailing_pe?: number; beta?: number; currency?: string;
  price?: number; fifty_two_high?: number; fifty_two_low?: number;
};
export type Watchlist = { id: string; name: string; tickers: string[] };

export const api = {
  // auth
  login: (username: string, password: string) =>
    apiFetch<{ access_token: string; expires_at: string; role: string }>(
      "/api/v1/auth/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
    ),
  me: () => apiFetch<{ username: string; role: string }>("/api/v1/auth/me"),

  // market
  search: (q: string) =>
    apiFetch<{ symbol: string; name: string; exchange?: string }[]>(
      `/api/v1/market/search?q=${encodeURIComponent(q)}`,
    ),
  quote: (ticker: string) =>
    apiFetch<Quote>(`/api/v1/market/quote/${encodeURIComponent(ticker)}`),
  quoteBulk: (tickers: string[]) =>
    apiFetch<Record<string, Quote | null>>(
      `/api/v1/market/quote-bulk?symbols=${encodeURIComponent(tickers.join(","))}`,
    ),
  history: (ticker: string, period = "1Y") =>
    apiFetch<{ ticker: string; period: string; candles: any[] }>(
      `/api/v1/market/history/${encodeURIComponent(ticker)}?period=${period}`,
    ),
  snapshot: (ticker: string) =>
    apiFetch<Snapshot>(`/api/v1/market/snapshot/${encodeURIComponent(ticker)}`),

  // watchlists
  listWatchlists: () => apiFetch<Watchlist[]>("/api/v1/watchlists"),
  createWatchlist: (name: string, tickers: string[]) =>
    apiFetch<Watchlist>("/api/v1/watchlists", {
      method: "POST", body: JSON.stringify({ name, tickers }),
    }),
  deleteWatchlist: (id: string) =>
    apiFetch<void>(`/api/v1/watchlists/${id}`, { method: "DELETE" }),

  // screens
  preset: (name: string) =>
    apiFetch<any[]>(`/api/v1/screens/preset/${encodeURIComponent(name)}`),
};
