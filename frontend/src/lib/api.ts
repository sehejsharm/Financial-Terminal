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
  /** Abort the request after this many ms (default 30s). A hung provider
   *  call must surface as a retryable error, never an eternal spinner. */
  timeoutMs?: number;
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`,
                      { ...init, headers, cache: "no-store", signal: ctrl.signal });
  } catch (e: any) {
    throw new ApiError(0, e?.name === "AbortError"
      ? "Request timed out — the data provider may be slow. Try again."
      : "Network error — check your connection and retry.");
  } finally {
    clearTimeout(timer);
  }
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
  /** Which provider produced the data (e.g. "FMP", "yfinance"). */
  source?: string | null;
  /** Backend explanation when rows are empty. */
  note?: string | null;
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
export type ChainNode = {
  name: string;
  note?: string;
  /** AI-estimated share (0-100) of the subject's revenue (customers) or
   *  input costs (suppliers) — an estimate, not filing-sourced. */
  revenue_pct?: number | null;
  /** AI-suggested primary ticker for this partner — must be verified. */
  ticker?: string | null;
  /** Provenance tier: "estimated" (AI) or "verified" (admin-published). */
  confidence?: "estimated" | "verified";
  verified_at?: string | null;
  locked?: boolean;
};
export type ResolveRec = { symbol: string; name: string; exchange: string; isin?: string };
export type ResolveResult = {
  status: "resolved" | "ambiguous" | "none";
  input: string;
  match: ResolveRec | null;
  candidates: ResolveRec[];
};
export type VcHistoryEntry = { ticker: string; generated_at: string | null; data: ValueChain };
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
export type VcReport = {
  ts: string; user: string | null; ticker: string;
  node_name: string; role: string; reason: string;
};

// ── Phase 6 types ───────────────────────────────────────────────────────────
export type Position = { id: string; ticker: string; qty: number; cost: number };
export type PortfolioRow = Position & {
  name?: string; sector?: string | null; beta?: number | null;
  dividend_yield?: number | null; price?: number | null; value?: number | null;
  pnl?: number | null; pnl_pct?: number | null; day_pnl?: number | null;
  weight?: number | null; currency?: string | null;
};
export type RealizedEvent = {
  ts: string; ticker: string; qty: number; cost: number;
  sell_price: number; pnl: number;
};
export type PortfolioSummary = {
  portfolio?: { id: string; name: string };
  realized?: { total: number; events: RealizedEvent[] };
  positions: PortfolioRow[];
  totals: { value: number; cost: number; pnl: number; pnl_pct: number | null; day_pnl: number } | null;
  sectors: { sector: string; value: number; weight: number }[];
  factors: { beta: number | null; dividend_yield: number | null; top_weight: number | null } | null;
};
export type PortfolioInfo = { id: string; name: string; positions: number };
export type PortfolioHistoryPoint = {
  date: string; value: number; cost: number; unrealized: number; realized_cum: number;
};
export type Alert = {
  id: string; kind: "price" | "pe" | "spread_10y2y"; ticker: string | null;
  op: ">" | "<"; value: number; active: boolean;
  created_at: string; triggered_at: string | null;
};
export type AlertEvent = {
  ts: string; alert_id: string; message: string; value: number;
  /** Per-channel delivery outcome ({email: true, telegram: false}); absent
   *  on events fired before delivery history existed. */
  delivery?: Record<string, boolean>;
};
export type Note = { ticker: string; text: string; updated_at: string | null };
export type WorkspacePane = { widget: string; ticker?: string | null };
export type WorkspaceLayout = { id: string; name: string; panes: WorkspacePane[]; split: number[] };
export type SentimentItem = { title: string; sentiment: "bull" | "bear" | "neutral" };
export type SentimentResp = {
  ticker: string; items: SentimentItem[]; score: number | null;
  history: { ts: string; ticker: string; score: number; n: number }[];
};
export type FlowRow = {
  symbol: string; deals: number; participants: number | null;
  buy_qty: number; sell_qty: number; net_qty: number;
  buy_value: number | null; sell_value: number | null; net_value: number | null;
};
export type InsiderRow = {
  symbol?: string; company?: string; person?: string; category?: string;
  type?: string; qty?: number | null; value?: number | null; date?: string;
};
export type CalendarRow = {
  name: string; unit: string; last_value: number | null; prior: number | null;
  surprise_vs_prior: number | null; last_release: string | null;
  stale: boolean; next_release_est: string | null;
};
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
  /** True when the last observation is older than a sane threshold for the
   *  indicator's cadence — render a STALE badge, don't present as current. */
  stale?: boolean;
};
export type YieldPoint = { maturity: string; years: number; yield: number };
export type YieldCurve = {
  country: string;
  points: YieldPoint[];
  /** Set when no curve exists for this market (explicit empty state). */
  note?: string | null;
};
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
  yieldCurve: (country = "US", opts?: FetchOpts) =>
    apiFetchMeta<YieldCurve>(`/api/v1/macro/yield-curve?country=${encodeURIComponent(country)}`, {}, opts),

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
  peers: (ticker: string) =>
    apiFetch<{ peers: string[]; sector: string | null; basis: string; market: string }>(
      `/api/v1/fundamentals/${encodeURIComponent(ticker)}/peers`),
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

  // resolution
  resolve: (q: string) =>
    apiFetch<ResolveResult>(`/api/v1/market/resolve?q=${encodeURIComponent(q)}`),

  // value chain
  valueChain: (ticker: string, refresh = false) =>
    apiFetchMeta<ValueChain>(
      `/api/v1/value-chain/${encodeURIComponent(ticker)}${refresh ? "?refresh=1" : ""}`,
      {}, { fresh: refresh }),
  vcHistory: (ticker: string) =>
    apiFetch<VcHistoryEntry[]>(`/api/v1/value-chain/${encodeURIComponent(ticker)}/history`),
  vcOverride: (ticker: string, o: { role: string; node_name: string; revenue_pct?: number | null; note?: string; locked?: boolean }) =>
    apiFetch<{ ok: boolean }>(`/api/v1/value-chain/${encodeURIComponent(ticker)}/override`, {
      method: "PUT", body: JSON.stringify(o),
    }),
  reportValueChain: (ticker: string, payload: { node_name: string; role: string; reason?: string }) =>
    apiFetch<{ ok: boolean }>(`/api/v1/value-chain/${encodeURIComponent(ticker)}/report`, {
      method: "POST", body: JSON.stringify({ reason: "", ...payload }),
    }),
  vcReports: (limit = 200) =>
    apiFetch<VcReport[]>(`/api/v1/value-chain/reports/all?limit=${limit}`),

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

  // portfolio
  portfolio: () => apiFetch<{ positions: Position[] }>("/api/v1/portfolio"),
  portfolioSummary: (pid?: string) =>
    apiFetch<PortfolioSummary>(`/api/v1/portfolio/summary${pid ? `?pid=${encodeURIComponent(pid)}` : ""}`),
  portfolioList: () => apiFetch<PortfolioInfo[]>("/api/v1/portfolio/list"),
  portfolioCreate: (name: string) =>
    apiFetch<PortfolioInfo>("/api/v1/portfolio/create", {
      method: "POST", body: JSON.stringify({ name }),
    }),
  portfolioDelete: (pid: string) =>
    apiFetch<void>(`/api/v1/portfolio/${encodeURIComponent(pid)}`, { method: "DELETE" }),
  portfolioHistory: (pid?: string) =>
    apiFetch<{ portfolio: { id: string; name: string }; points: PortfolioHistoryPoint[] }>(
      `/api/v1/portfolio/history${pid ? `?pid=${encodeURIComponent(pid)}` : ""}`),
  portfolioImport: (positions: { ticker: string; qty: number; cost: number }[], pid?: string) =>
    apiFetch<{ added: number; skipped: string[] }>("/api/v1/portfolio/import", {
      method: "POST", body: JSON.stringify({ positions, pid: pid ?? null }),
    }),
  closePosition: (id: string, opts?: { pid?: string; sellPrice?: number }) => {
    const params = new URLSearchParams();
    if (opts?.pid) params.set("pid", opts.pid);
    if (opts?.sellPrice != null) params.set("sell_price", String(opts.sellPrice));
    const qs = params.toString();
    return apiFetch<{ ok: boolean; realized: RealizedEvent | null }>(
      `/api/v1/portfolio/positions/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
      { method: "DELETE" });
  },
  addPosition: (ticker: string, qty: number, cost: number, pid?: string) =>
    apiFetch<Position>("/api/v1/portfolio/positions", {
      method: "POST", body: JSON.stringify({ ticker, qty, cost, pid: pid ?? null }),
    }),
  deletePosition: (id: string) =>
    apiFetch<void>(`/api/v1/portfolio/positions/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // alerts
  alerts: () => apiFetch<{ alerts: Alert[]; events: AlertEvent[] }>("/api/v1/alerts"),
  createAlert: (a: { kind: string; ticker?: string | null; op: string; value: number }) =>
    apiFetch<Alert>("/api/v1/alerts", { method: "POST", body: JSON.stringify(a) }),
  deleteAlert: (id: string) =>
    apiFetch<void>(`/api/v1/alerts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  alertEvents: () => apiFetch<AlertEvent[]>("/api/v1/alerts/events"),
  pushConfig: () =>
    apiFetch<{ email: boolean; push: boolean; telegram: boolean;
               vapid_public_key: string | null;
               my_email: string | null; telegram_linked: boolean }>(
      "/api/v1/alerts/push/config"),
  pushSubscribe: (sub: PushSubscriptionJSON) =>
    apiFetch<{ ok: boolean; devices: number }>("/api/v1/alerts/push/subscribe", {
      method: "POST", body: JSON.stringify(sub),
    }),
  alertTest: () =>
    apiFetch<{ channels: { email: boolean; push: boolean; telegram: boolean }; devices: number;
               results: { email: boolean | null; push: boolean | null; telegram: boolean | null } }>(
      "/api/v1/alerts/test", { method: "POST", body: "{}" }),
  setDeliveryEmail: (email: string) =>
    apiFetch<{ ok: boolean; email: string | null }>("/api/v1/alerts/delivery", {
      method: "PUT", body: JSON.stringify({ email }),
    }),
  telegramStart: () =>
    apiFetch<{ bot: string | null; code: string }>("/api/v1/alerts/telegram/start",
      { method: "POST", body: "{}" }),
  telegramVerify: () =>
    apiFetch<{ ok: boolean }>("/api/v1/alerts/telegram/verify",
      { method: "POST", body: "{}" }),
  telegramUnlink: () =>
    apiFetch<void>("/api/v1/alerts/telegram", { method: "DELETE" }),
  deliveryServerConfig: () =>
    apiFetch<{ settings: Record<string, string>;
               channels: { email: boolean; push: boolean; telegram: boolean };
               telegram_bot: string | null }>("/api/v1/alerts/delivery/server"),
  saveDeliveryServerConfig: (settings: Record<string, string>) =>
    apiFetch<{ ok: boolean; channels: { email: boolean; push: boolean; telegram: boolean } }>(
      "/api/v1/alerts/delivery/server", { method: "PUT", body: JSON.stringify(settings) }),

  // notes
  note: (ticker: string) => apiFetch<Note>(`/api/v1/notes/${encodeURIComponent(ticker)}`),
  saveNote: (ticker: string, text: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/notes/${encodeURIComponent(ticker)}`, {
      method: "PUT", body: JSON.stringify({ text }),
    }),

  // workspaces
  workspaces: () => apiFetch<{ layouts: WorkspaceLayout[] }>("/api/v1/workspaces"),
  saveWorkspaces: (layouts: WorkspaceLayout[]) =>
    apiFetch<{ ok: boolean }>("/api/v1/workspaces", {
      method: "PUT", body: JSON.stringify({ layouts }),
    }),

  // sentiment + flow intel + calendar
  sentiment: (ticker: string) =>
    apiFetch<SentimentResp>("/api/v1/ai/sentiment", {
      method: "POST", body: JSON.stringify({ ticker }),
    }),
  dealsAggregate: (kind: "bulk" | "block" = "bulk", days = 30) =>
    apiFetch<{ rows: FlowRow[]; from: string | null; to: string | null; note: string | null }>(
      `/api/v1/deals/aggregate?kind=${kind}&days=${days}`),
  insiderDeals: () =>
    apiFetch<{ rows: InsiderRow[]; note: string | null }>("/api/v1/deals/insider"),
  macroCalendar: (country = "US") =>
    apiFetch<{ country: string; rows: CalendarRow[]; note: string }>(
      `/api/v1/macro/calendar?country=${encodeURIComponent(country)}`),

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
