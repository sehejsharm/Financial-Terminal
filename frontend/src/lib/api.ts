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

// ── client-side cache ────────────────────────────────────────────────────
// Tiny localStorage cache for GET responses that are slow upstream and don't
// change often (financials, ownership, ratings). Skipped for live data
// (quote, quote-bulk, history, movers). Keeps the UI feeling instant after
// you've visited a ticker once, without inventing a new state-management
// layer. Wiped automatically on 401 (logout).
const CACHE_PREFIX = "mb_cache_v1:";
const CACHE_TTL_MS: Record<string, number> = {
  "/api/v1/fundamentals/": 5 * 60_000,
  "/api/v1/market/snapshot/": 60_000,
  "/api/v1/market/search": 5 * 60_000,
  "/api/v1/value-chain/": 12 * 60 * 60_000,
  "/api/v1/macro/": 30 * 60_000,
};
function ttlFor(path: string): number {
  for (const [pref, ttl] of Object.entries(CACHE_TTL_MS)) {
    if (path.startsWith(pref)) return ttl;
  }
  return 0;
}
function cacheGet(path: string): { v: unknown; t: number } | null {
  if (typeof localStorage === "undefined") return null;
  const ttl = ttlFor(path);
  if (!ttl) return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + path);
    if (!raw) return null;
    const { v, t } = JSON.parse(raw) as { v: unknown; t: number };
    if (Date.now() - t > ttl) { localStorage.removeItem(CACHE_PREFIX + path); return null; }
    return { v, t };
  } catch { return null; }
}
function cacheSet(path: string, v: unknown) {
  if (typeof localStorage === "undefined") return;
  if (!ttlFor(path)) return;
  try { localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ v, t: Date.now() })); }
  catch { /* quota; ignore */ }
}
function cacheClearAll() {
  if (typeof localStorage === "undefined") return;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  }
}

export type FetchOpts = {
  /** Bypass the localStorage cache and hit the network (still re-caches). */
  fresh?: boolean;
};

export type FetchMeta<T> = {
  data: T;
  /** Epoch ms when this payload was fetched from the network. */
  fetchedAt: number;
  fromCache: boolean;
};

/** Like apiFetch, but also reports when the data was actually fetched, so the
 *  UI can render "Updated Xm ago" instead of silently serving stale cache. */
export async function apiFetchMeta<T = unknown>(
  path: string,
  init: RequestInit = {},
  opts: FetchOpts = {},
): Promise<FetchMeta<T>> {
  const isGet = !init.method || init.method.toUpperCase() === "GET";
  if (isGet && !opts.fresh) {
    const hit = cacheGet(path);
    if (hit !== null) return { data: hit.v as T, fetchedAt: hit.t, fromCache: true };
  }

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
    if (res.status === 401) { token.clear(); cacheClearAll(); }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return { data: undefined as T, fetchedAt: Date.now(), fromCache: false };
  const body = (await res.json()) as T;
  if (isGet) cacheSet(path, body);
  return { data: body, fetchedAt: Date.now(), fromCache: false };
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  opts: FetchOpts = {},
): Promise<T> {
  return (await apiFetchMeta<T>(path, init, opts)).data;
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

export type Statement = {
  ticker: string; kind: string; quarterly?: boolean;
  columns: string[];
  rows: Array<Record<string, number | string | null> & { line: string }>;
};
export type Estimates = {
  price_targets?: Record<string, number | null>;
  earnings_estimate?: Record<string, Record<string, number | null>>;
  revenue_estimate?: Record<string, Record<string, number | null>>;
  growth_estimates?: Record<string, Record<string, number | null>>;
  [k: string]: unknown;
};
export type CapStructure = {
  total_debt: number | null; cash: number | null; market_cap: number | null;
  shares: number | null; currency: string;
};
export type ChainNode = { name: string; note?: string };
export type ValueChain = {
  ticker: string; name: string;
  suppliers?: ChainNode[]; customers?: ChainNode[]; competitors?: ChainNode[];
  /** ISO timestamp of when the AI generated this map (server-side). */
  generated_at?: string;
  /** AI provider that produced the map, e.g. "Groq (Llama 3.3)". */
  source?: string;
};
export type OptionRow = Record<string, number | string | boolean | null>;
export type OptionChain = {
  ticker: string; expiry: string; spot: number; years_to_expiry: number;
  calls: OptionRow[]; puts: OptionRow[]; max_pain: number | null;
};
export type AIResp = { ticker: string; markdown: string };
export type Mover = Record<string, number | string | null>;
export type Frame = { columns: string[]; rows: Array<Record<string, number | string | null>> };
export type CompRow = Record<string, number | string | null>;
export type Ownership = {
  major_holders: Frame; institutional_holders: Frame; mutualfund_holders: Frame;
  officers: Array<{ name?: string; title?: string; pay?: number | null; age?: number | null }>;
};
export type Ratings = { targets: Record<string, number | string | null>; recommendations: Frame };
export type NewsItem = {
  title: string; publisher: string; link: string;
  summary: string; published: string | null;
};
export type Indicator = {
  name: string; value: number | null; prior: number | null;
  change: number | null; date: string | null; unit: string;
};
export type YieldPoint = { maturity: string; years: number; yield: number };
export type DealRow = Record<string, number | string | null>;
export type AdminUser = { username: string; role: string; active?: boolean; created_at?: string };
export type AuditEvent = {
  ts: string; user: string | null; ip?: string | null;
  method: string; path: string; status: number; latency_ms: number;
};

export type ScreenResult = {
  rows: any[];
  scanned?: number;
  evaluable?: number | null;
  note?: string | null;
  /** ISO timestamp of the underlying universe scan (server-side cache). */
  as_of?: string | null;
};

// Backend now returns {rows, scanned, evaluable, note}; tolerate the old bare
// array too so a partial deploy never breaks the screeners page.
function normScreen(r: unknown): ScreenResult {
  if (Array.isArray(r)) return { rows: r };
  const o = (r ?? {}) as any;
  return {
    rows: Array.isArray(o.rows) ? o.rows : [],
    scanned: o.scanned,
    evaluable: o.evaluable ?? null,
    note: o.note ?? null,
    as_of: o.as_of ?? null,
  };
}

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
  snapshot: (ticker: string, opts?: FetchOpts) =>
    apiFetch<Snapshot>(`/api/v1/market/snapshot/${encodeURIComponent(ticker)}`, {}, opts),
  snapshotMeta: (ticker: string, opts?: FetchOpts) =>
    apiFetchMeta<Snapshot>(`/api/v1/market/snapshot/${encodeURIComponent(ticker)}`, {}, opts),
  movers: (kind: "gainers" | "losers" = "gainers", count = 8) =>
    apiFetch<Mover[]>(`/api/v1/market/movers?kind=${kind}&count=${count}`),
  news: (ticker: string, limit = 15) =>
    apiFetch<NewsItem[]>(`/api/v1/market/news/${encodeURIComponent(ticker)}?limit=${limit}`),
  marketNews: (limit = 30) =>
    apiFetch<NewsItem[]>(`/api/v1/market/news?limit=${limit}`),

  // macro
  macroCountries: () => apiFetch<string[]>("/api/v1/macro/countries"),
  macroIndicators: (country = "US", opts?: FetchOpts) =>
    apiFetchMeta<Indicator[]>(`/api/v1/macro/indicators?country=${encodeURIComponent(country)}`, {}, opts),
  yieldCurve: (opts?: FetchOpts) =>
    apiFetchMeta<YieldPoint[]>("/api/v1/macro/yield-curve", {}, opts),

  // deals
  bulkDeals: () => apiFetch<DealRow[]>("/api/v1/deals/bulk"),
  blockDeals: () => apiFetch<DealRow[]>("/api/v1/deals/block"),

  // admin
  adminUsers: () => apiFetch<AdminUser[]>("/api/v1/admin/users"),
  adminCreateUser: (username: string, password: string, role: "user" | "master_admin") =>
    apiFetch<{ ok: boolean; message: string }>("/api/v1/admin/users", {
      method: "POST", body: JSON.stringify({ username, password, role }),
    }),
  adminDeactivateUser: (username: string) =>
    apiFetch<void>(`/api/v1/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" }),
  adminAudit: (limit = 200) =>
    apiFetch<AuditEvent[]>(`/api/v1/admin/audit?limit=${limit}`),

  // fundamentals
  statement: (ticker: string, kind: "income" | "balance" | "cashflow", quarterly = false, opts?: FetchOpts) =>
    apiFetchMeta<Statement>(
      `/api/v1/fundamentals/${encodeURIComponent(ticker)}/statement/${kind}?quarterly=${quarterly}`,
      {}, opts,
    ),
  estimates: (ticker: string) =>
    apiFetch<Estimates>(`/api/v1/fundamentals/${encodeURIComponent(ticker)}/estimates`),
  capitalStructure: (ticker: string) =>
    apiFetch<CapStructure>(`/api/v1/fundamentals/${encodeURIComponent(ticker)}/capital-structure`),
  comps: (tickers: string[]) =>
    apiFetch<CompRow[]>(`/api/v1/fundamentals/comps?tickers=${encodeURIComponent(tickers.join(","))}`),
  ownership: (ticker: string) =>
    apiFetch<Ownership>(`/api/v1/fundamentals/${encodeURIComponent(ticker)}/ownership`),
  earningsHistory: (ticker: string) =>
    apiFetch<Frame>(`/api/v1/fundamentals/${encodeURIComponent(ticker)}/earnings-history`),
  ratings: (ticker: string) =>
    apiFetch<Ratings>(`/api/v1/fundamentals/${encodeURIComponent(ticker)}/ratings`),

  // options
  optionExpiries: (ticker: string) =>
    apiFetch<string[]>(`/api/v1/options/${encodeURIComponent(ticker)}/expiries`),
  optionChain: (ticker: string, expiry: string) =>
    apiFetch<OptionChain>(
      `/api/v1/options/${encodeURIComponent(ticker)}/chain?expiry=${encodeURIComponent(expiry)}`,
    ),

  // value chain
  valueChain: (ticker: string) =>
    apiFetchMeta<ValueChain>(`/api/v1/value-chain/${encodeURIComponent(ticker)}`),

  // ai
  aiProvider: () =>
    apiFetch<{ available: boolean; provider: string | null }>("/api/v1/ai/provider"),
  bullBear: (ticker: string) =>
    apiFetch<AIResp>("/api/v1/ai/bull-bear", {
      method: "POST", body: JSON.stringify({ ticker }),
    }),
  deepAnalysis: (ticker: string) =>
    apiFetch<AIResp>("/api/v1/ai/deep-analysis", {
      method: "POST", body: JSON.stringify({ ticker }),
    }),

  // watchlists
  listWatchlists: () => apiFetch<Watchlist[]>("/api/v1/watchlists"),
  createWatchlist: (name: string, tickers: string[]) =>
    apiFetch<Watchlist>("/api/v1/watchlists", {
      method: "POST", body: JSON.stringify({ name, tickers }),
    }),
  updateWatchlist: (id: string, name: string, tickers: string[]) =>
    apiFetch<Watchlist>(`/api/v1/watchlists/${id}`, {
      method: "PUT", body: JSON.stringify({ name, tickers }),
    }),
  deleteWatchlist: (id: string) =>
    apiFetch<void>(`/api/v1/watchlists/${id}`, { method: "DELETE" }),

  // screens
  preset: (name: string) =>
    apiFetch<unknown>(`/api/v1/screens/preset/${encodeURIComponent(name)}`).then(normScreen),
  screenBuffett: (min_score = 70) =>
    apiFetch<unknown>("/api/v1/screens/buffett", {
      method: "POST", body: JSON.stringify({ min_score }),
    }).then(normScreen),
  screenGraham: (growth_default = 8, bond_yield = 7, min_mos = 20) =>
    apiFetch<unknown>("/api/v1/screens/graham", {
      method: "POST", body: JSON.stringify({ growth_default, bond_yield, min_mos }),
    }).then(normScreen),
  screenEtfs: (sort_by = "ytd_return", sector: string | null = null) =>
    apiFetch<unknown>("/api/v1/screens/etfs", {
      method: "POST", body: JSON.stringify({ sort_by, sector }),
    }).then(normScreen),
};
