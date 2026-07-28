/** The instrument catalogue behind the dashboard and the Global board.
 *
 *  One place that knows what a symbol IS — its display name, what class of
 *  thing it is, which region it belongs to, and crucially how likely the free
 *  data path is to price it. That last field is why this file exists rather
 *  than a scattering of string literals: a tile that shows "—" forever is
 *  indistinguishable from a broken tile unless the UI can explain WHY.
 *
 *  Coverage tiers:
 *    "nse"      served direct from NSE — fast, reliable, never IP-blocked.
 *    "provider" routed via Twelve Data / yfinance. Free tiers are rate-limited
 *               and yfinance is blocked from some cloud IPs, so these price
 *               most of the time but not always.
 *    "none"     known to have no free symbol at all. Never put in a default
 *               layout; shown in the picker with the reason so its absence
 *               reads as a decision rather than an oversight.
 */

export type InstrumentKind = "index" | "sector" | "commodity" | "fx" | "vol";
export type Coverage = "nse" | "provider" | "none";

export type Instrument = {
  sym: string;
  /** Full name for tooltips and wide layouts. */
  label: string;
  /** Compact name for dense tiles — must fit ~14 characters. */
  short: string;
  kind: InstrumentKind;
  coverage: Coverage;
  /** Why this can't be priced. Only meaningful when coverage is "none". */
  note?: string;
};

function I(
  sym: string, short: string, label: string, kind: InstrumentKind,
  coverage: Coverage = "provider", note?: string,
): Instrument {
  return { sym, short, label, kind, coverage, note };
}

// ── Indian ────────────────────────────────────────────────────────────────
const IN_INDICES = [
  I("^NSEI", "NIFTY 50", "NIFTY 50", "index", "nse"),
  I("^BSESN", "SENSEX", "BSE SENSEX", "index", "nse"),
  I("^NSEBANK", "BANK NIFTY", "NIFTY Bank", "index", "nse"),
  I("^CNXMIDCAP", "MIDCAP 100", "NIFTY Midcap 100", "index", "nse"),
  I("^CNX500", "NIFTY 500", "NIFTY 500", "index", "nse"),
  I("^INDIAVIX", "INDIA VIX", "India VIX", "vol", "nse"),
];

const IN_SECTORS = [
  I("^CNXIT", "NIFTY IT", "NIFTY IT", "sector", "nse"),
  I("^CNXFMCG", "NIFTY FMCG", "NIFTY FMCG", "sector", "nse"),
  I("^CNXAUTO", "NIFTY AUTO", "NIFTY Auto", "sector", "nse"),
  I("^CNXPHARMA", "NIFTY PHARMA", "NIFTY Pharma", "sector", "nse"),
  I("^CNXMETAL", "NIFTY METAL", "NIFTY Metal", "sector", "nse"),
  I("^CNXENERGY", "NIFTY ENERGY", "NIFTY Energy", "sector", "nse"),
];

// ── World equity ──────────────────────────────────────────────────────────
const US_INDICES = [
  I("^GSPC", "S&P 500", "S&P 500", "index"),
  I("^DJI", "DOW JONES", "Dow Jones Industrial Average", "index"),
  I("^IXIC", "NASDAQ", "Nasdaq Composite", "index"),
  I("^RUT", "RUSSELL 2K", "Russell 2000", "index"),
  I("^VIX", "VIX", "CBOE Volatility Index", "vol"),
];

const EU_INDICES = [
  I("^FTSE", "FTSE 100", "FTSE 100 (UK)", "index"),
  I("^GDAXI", "DAX", "DAX (Germany)", "index"),
  I("^FCHI", "CAC 40", "CAC 40 (France)", "index"),
  I("^STOXX50E", "EURO STOXX", "Euro Stoxx 50", "index"),
  I("^IBEX", "IBEX 35", "IBEX 35 (Spain)", "index"),
  I("^FTMC", "FTSE 250", "FTSE 250 (UK mid-cap)", "index"),
];

const APAC_INDICES = [
  I("^N225", "NIKKEI 225", "Nikkei 225 (Japan)", "index"),
  I("^HSI", "HANG SENG", "Hang Seng (Hong Kong)", "index"),
  I("^KS11", "KOSPI", "KOSPI (South Korea)", "index"),
  I("^AXJO", "ASX 200", "S&P/ASX 200 (Australia)", "index"),
  I("^STI", "STI", "Straits Times Index (Singapore)", "index"),
  I("000001.SS", "SHANGHAI", "SSE Composite (China)", "index"),
];

// ── Commodities ───────────────────────────────────────────────────────────
const METALS = [
  I("GC=F", "GOLD", "Gold futures (COMEX)", "commodity"),
  I("SI=F", "SILVER", "Silver futures (COMEX)", "commodity"),
  I("HG=F", "COPPER", "Copper futures (COMEX)", "commodity"),
  I("PL=F", "PLATINUM", "Platinum futures", "commodity"),
];

const ENERGY = [
  I("CL=F", "WTI CRUDE", "WTI Crude futures", "commodity"),
  I("BZ=F", "BRENT", "Brent Crude futures", "commodity"),
  I("NG=F", "NAT GAS", "Natural Gas futures", "commodity"),
  I("RB=F", "GASOLINE", "RBOB Gasoline futures", "commodity"),
];

const AGRI = [
  I("ZW=F", "WHEAT", "Wheat futures", "commodity"),
  I("ZC=F", "CORN", "Corn futures", "commodity"),
  I("ZS=F", "SOYBEANS", "Soybean futures", "commodity"),
  I("SB=F", "SUGAR", "Sugar futures", "commodity"),
];

// ── FX ────────────────────────────────────────────────────────────────────
const FX_INR = [
  I("USDINR=X", "USD / INR", "US Dollar / Indian Rupee", "fx"),
  I("EURINR=X", "EUR / INR", "Euro / Indian Rupee", "fx"),
  I("GBPINR=X", "GBP / INR", "Pound Sterling / Indian Rupee", "fx"),
  I("JPYINR=X", "JPY / INR", "Japanese Yen / Indian Rupee", "fx"),
];

const FX_MAJORS = [
  I("EURUSD=X", "EUR / USD", "Euro / US Dollar", "fx"),
  I("GBPUSD=X", "GBP / USD", "Pound Sterling / US Dollar", "fx"),
  I("USDJPY=X", "USD / JPY", "US Dollar / Japanese Yen", "fx"),
  I("USDCHF=X", "USD / CHF", "US Dollar / Swiss Franc", "fx"),
];

const FX_OTHER = [
  I("AUDUSD=X", "AUD / USD", "Australian Dollar / US Dollar", "fx"),
  I("USDCAD=X", "USD / CAD", "US Dollar / Canadian Dollar", "fx"),
  I("USDCNY=X", "USD / CNY", "US Dollar / Chinese Yuan", "fx"),
  I("USDSGD=X", "USD / SGD", "US Dollar / Singapore Dollar", "fx"),
  I("EURGBP=X", "EUR / GBP", "Euro / Pound Sterling", "fx"),
  I("USDAED=X", "USD / AED", "US Dollar / UAE Dirham", "fx"),
];

/** Known-unpriceable, catalogued so their absence is explained, not silent. */
const UNAVAILABLE = [
  I("GIFTNIFTY", "GIFT NIFTY", "GIFT Nifty (NSE IX)", "index", "none",
    "GIFT Nifty (formerly SGX Nifty) is an NSE IX product with no free quote "
    + "symbol on Yahoo or Twelve Data. It needs a paid NSE IX / exchange feed."),
  I("^DJI.D", "DOW FUTURES", "Dow Jones futures", "index", "none",
    "Index futures need a futures data entitlement; the free tiers carry the "
    + "cash index only."),
];

export const ALL_INSTRUMENTS: Instrument[] = [
  ...IN_INDICES, ...IN_SECTORS, ...US_INDICES, ...EU_INDICES, ...APAC_INDICES,
  ...METALS, ...ENERGY, ...AGRI, ...FX_INR, ...FX_MAJORS, ...FX_OTHER,
  ...UNAVAILABLE,
];

const BY_SYM = new Map(ALL_INSTRUMENTS.map((i) => [i.sym, i]));

/** Catalogue lookup. Unknown symbols degrade to a usable tile rather than
 *  crashing — a user can type any ticker into a custom section. */
export function instrument(sym: string): Instrument {
  const hit = BY_SYM.get(sym);
  if (hit) return hit;
  const bare = sym.replace(/\.(NS|BO)$/i, "").replace(/^\^/, "");
  return {
    sym,
    label: sym,
    short: bare.length > 14 ? `${bare.slice(0, 13)}…` : bare,
    kind: "index",
    // Indian listings resolve through the direct NSE provider.
    coverage: /\.(NS|BO)$/i.test(sym) ? "nse" : "provider",
  };
}

// ── section presets ───────────────────────────────────────────────────────
// The building blocks a user assembles their dashboard out of.

export type SectionPreset = {
  id: string;
  title: string;
  symbols: string[];
  /** One line describing what this board is for. */
  blurb: string;
};

export const SECTION_PRESETS: SectionPreset[] = [
  { id: "in_indices", title: "India · Indices", blurb: "NIFTY, SENSEX, Bank NIFTY and the volatility gauge.", symbols: IN_INDICES.map((i) => i.sym) },
  { id: "in_sectors", title: "India · Sectors", blurb: "The NIFTY sector sub-indices.", symbols: IN_SECTORS.map((i) => i.sym) },
  { id: "us_indices", title: "United States", blurb: "S&P 500, Dow, Nasdaq, Russell and the VIX.", symbols: US_INDICES.map((i) => i.sym) },
  { id: "eu_indices", title: "Europe & UK", blurb: "FTSE, DAX, CAC, Euro Stoxx.", symbols: EU_INDICES.map((i) => i.sym) },
  { id: "apac_indices", title: "Asia-Pacific", blurb: "Nikkei, Hang Seng, KOSPI, ASX, STI, Shanghai.", symbols: APAC_INDICES.map((i) => i.sym) },
  { id: "metals", title: "Metals", blurb: "Gold, silver, copper, platinum.", symbols: METALS.map((i) => i.sym) },
  { id: "energy", title: "Energy", blurb: "WTI, Brent, natural gas, gasoline.", symbols: ENERGY.map((i) => i.sym) },
  { id: "agri", title: "Agriculture", blurb: "Wheat, corn, soybeans, sugar.", symbols: AGRI.map((i) => i.sym) },
  { id: "fx_inr", title: "Rupee crosses", blurb: "USD, EUR, GBP and JPY against the rupee.", symbols: FX_INR.map((i) => i.sym) },
  { id: "fx_majors", title: "FX majors", blurb: "The four most-traded dollar pairs.", symbols: FX_MAJORS.map((i) => i.sym) },
  { id: "fx_other", title: "FX · other crosses", blurb: "Commodity blocs, Asia and the euro cross.", symbols: FX_OTHER.map((i) => i.sym) },
];

export function preset(id: string): SectionPreset | undefined {
  return SECTION_PRESETS.find((p) => p.id === id);
}

// ── home region ───────────────────────────────────────────────────────────
// "Where in the world am I sitting?" reorders the whole dashboard: your own
// market first, your own currency crosses, your own exchange clock leading.

export type RegionId = "IN" | "US" | "UK" | "EU" | "JP" | "SG" | "AU" | "AE";

export type Region = {
  id: RegionId;
  label: string;
  flag: string;
  currency: string;
  /** Exchange codes for the status rail, home market first. */
  clocks: string[];
  /** Section preset ids, in the order they should appear. */
  layout: string[];
};

export const REGIONS: Region[] = [
  {
    id: "IN", label: "India", flag: "🇮🇳", currency: "INR",
    clocks: ["NSE", "LSE", "NYSE", "TSE"],
    layout: ["in_indices", "in_sectors", "fx_inr", "metals", "energy", "us_indices", "apac_indices", "eu_indices"],
  },
  {
    id: "US", label: "United States", flag: "🇺🇸", currency: "USD",
    clocks: ["NYSE", "LSE", "TSE", "NSE"],
    layout: ["us_indices", "fx_majors", "energy", "metals", "eu_indices", "apac_indices", "in_indices"],
  },
  {
    id: "UK", label: "United Kingdom", flag: "🇬🇧", currency: "GBP",
    clocks: ["LSE", "NYSE", "TSE", "NSE"],
    layout: ["eu_indices", "fx_majors", "us_indices", "energy", "metals", "apac_indices", "in_indices"],
  },
  {
    id: "EU", label: "Europe", flag: "🇪🇺", currency: "EUR",
    clocks: ["LSE", "NYSE", "TSE", "NSE"],
    layout: ["eu_indices", "fx_majors", "us_indices", "energy", "metals", "apac_indices"],
  },
  {
    id: "JP", label: "Japan", flag: "🇯🇵", currency: "JPY",
    clocks: ["TSE", "HKEX", "LSE", "NYSE"],
    layout: ["apac_indices", "fx_majors", "us_indices", "metals", "energy", "eu_indices"],
  },
  {
    id: "SG", label: "Singapore", flag: "🇸🇬", currency: "SGD",
    clocks: ["SGX", "HKEX", "NSE", "NYSE"],
    layout: ["apac_indices", "fx_other", "in_indices", "energy", "metals", "us_indices"],
  },
  {
    id: "AU", label: "Australia", flag: "🇦🇺", currency: "AUD",
    clocks: ["ASX", "TSE", "LSE", "NYSE"],
    layout: ["apac_indices", "fx_other", "metals", "energy", "us_indices", "eu_indices"],
  },
  {
    id: "AE", label: "UAE / Gulf", flag: "🇦🇪", currency: "AED",
    clocks: ["NSE", "LSE", "NYSE", "TSE"],
    layout: ["energy", "metals", "in_indices", "fx_other", "us_indices", "eu_indices"],
  },
];

export const DEFAULT_REGION: RegionId = "IN";

export function region(id: string | null | undefined): Region {
  return REGIONS.find((r) => r.id === id) ?? REGIONS.find((r) => r.id === DEFAULT_REGION)!;
}

/** Best-effort home region from the browser's timezone. Only ever used as an
 *  initial suggestion — the user's explicit choice always wins and is what
 *  gets persisted. */
export function guessRegion(): RegionId {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (tz.startsWith("Asia/Kolkata") || tz.startsWith("Asia/Calcutta")) return "IN";
    if (tz.startsWith("Asia/Tokyo")) return "JP";
    if (tz.startsWith("Asia/Singapore")) return "SG";
    if (tz.startsWith("Asia/Dubai")) return "AE";
    if (tz.startsWith("Australia/")) return "AU";
    if (tz.startsWith("Europe/London")) return "UK";
    if (tz.startsWith("Europe/")) return "EU";
    if (tz.startsWith("America/")) return "US";
  } catch { /* fall through */ }
  return DEFAULT_REGION;
}
