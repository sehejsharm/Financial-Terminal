"""Fundamental stock screens over an Indian universe.

IMPORTANT - data caveats: free data (yfinance) does not expose 5- and 7-year
EPS/sales growth, promoter holding (only an insider-holding proxy), industry
P/E, or a clean ROCE for every name. So these screens are BEST-EFFORT
approximations: multi-year growth uses the latest trailing growth as a proxy,
ROCE falls back to ROCE-or-ROE where ROCE is missing, "promoter holding" uses
held-by-insiders, and the industry-P/E condition is skipped. Treat results as a
starting point for research, not a definitive screen.
"""
from __future__ import annotations

import streamlit as st

from lib.market_data import get_stock_fundamentals
from lib import nse

# Broader universe (large + some mid caps) so smaller-cap screens can match.
SCREEN_UNIVERSE = [
    "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS",
    "HINDUNILVR.NS", "ITC.NS", "SBIN.NS", "BHARTIARTL.NS", "KOTAKBANK.NS",
    "LT.NS", "BAJFINANCE.NS", "AXISBANK.NS", "ASIANPAINT.NS", "MARUTI.NS",
    "HCLTECH.NS", "SUNPHARMA.NS", "TITAN.NS", "ULTRACEMCO.NS", "WIPRO.NS",
    "NESTLEIND.NS", "ONGC.NS", "NTPC.NS", "POWERGRID.NS", "M&M.NS",
    "TATAMOTORS.NS", "TATASTEEL.NS", "JSWSTEEL.NS", "ADANIENT.NS", "COALINDIA.NS",
    "BAJAJFINSV.NS", "GRASIM.NS", "HINDALCO.NS", "BRITANNIA.NS", "CIPLA.NS",
    "DRREDDY.NS", "EICHERMOT.NS", "HEROMOTOCO.NS", "BPCL.NS", "TATACONSUM.NS",
    "APOLLOHOSP.NS", "INDUSINDBK.NS", "SBILIFE.NS", "HDFCLIFE.NS", "TECHM.NS",
    "TRENT.NS", "DIVISLAB.NS", "PIDILITIND.NS", "DABUR.NS", "MARICO.NS",
    "GODREJCP.NS", "BERGEPAINT.NS", "PAGEIND.NS", "MUTHOOTFIN.NS", "TVSMOTOR.NS",
    "BALKRISIND.NS", "ABBOTINDIA.NS", "COFORGE.NS", "PERSISTENT.NS", "MPHASIS.NS",
    "POLYCAB.NS", "ASTRAL.NS", "DEEPAKNTR.NS", "NAVINFLUOR.NS", "LALPATHLAB.NS",
    "AARTIIND.NS", "JUBLFOOD.NS", "RELAXO.NS", "VINATIORGA.NS", "CDSL.NS",
]

# Metrics available per the filter UI: (label, key, unit).
FILTER_METRICS = [
    ("Market cap (₹ cr)", "mcap_cr", "cr"),
    ("EPS growth (%)", "eps_growth", "%"),
    ("Sales growth (%)", "sales_growth", "%"),
    ("PEG ratio", "peg", ""),
    ("Debt / Equity", "de", ""),
    ("ROCE/ROE (%)", "roce", "%"),
    ("Promoter/insider holding (%)", "promoter", "%"),
    ("P/E", "pe", ""),
    ("ROE (%)", "roe", "%"),
]


def _fetch_fundamentals_default(ticker: str) -> dict:
    """Default fundamentals fetch: yfinance with an NSE overlay for .NS names.

    Many yfinance fields blank-out on cloud IPs where Yahoo bot-detects us, so
    we overlay NSE's direct data (name, sector, P/E, mcap) where available. The
    backend injects a richer provider (NSE + Twelve Data + yfinance) instead.
    """
    f = get_stock_fundamentals(ticker) or {}
    if nse.is_indian(ticker):
        n = nse.snapshot(ticker) or {}
        # Prefer NSE where yfinance is missing the value (cloud-block case).
        for k, v in n.items():
            if v is not None and f.get(k) in (None, "", 0):
                f[k] = v
    return f


def _build_metrics(ticker: str, f: dict | None) -> dict | None:
    """Pure transform: raw fundamentals dict -> screen metric row. No network."""
    f = f or {}
    if not f or f.get("market_cap") is None:
        return None
    mcap_cr = f["market_cap"] / 1e7  # INR -> crore
    eps_g = (f.get("earnings_growth") or 0) * 100 if f.get("earnings_growth") is not None else None
    sales_g = (f.get("revenue_growth") or 0) * 100 if f.get("revenue_growth") is not None else None
    roce = f.get("roce")
    roce = roce * 100 if roce is not None else (
        (f.get("roe") or 0) * 100 if f.get("roe") is not None else None)
    roe = (f.get("roe") or 0) * 100 if f.get("roe") is not None else None
    de = f.get("debt_to_equity")
    de = de / 100 if de is not None else None  # percentage -> ratio
    promoter = (f.get("held_insiders") or 0) * 100 if f.get("held_insiders") is not None else None
    return {
        "ticker": ticker.replace(".NS", ""),
        "name": f.get("name", ticker),
        "mcap_cr": round(mcap_cr, 0),
        "eps_growth": round(eps_g, 1) if eps_g is not None else None,
        "sales_growth": round(sales_g, 1) if sales_g is not None else None,
        "peg": f.get("peg"),
        "de": round(de, 2) if de is not None else None,
        "roce": round(roce, 1) if roce is not None else None,
        "roe": round(roe, 1) if roe is not None else None,
        "promoter": round(promoter, 1) if promoter is not None else None,
        "pe": f.get("trailing_pe"),
    }


@st.cache_data(ttl=3600, show_spinner=False)
def get_metrics(ticker: str) -> dict | None:
    """Best-effort metric set for one ticker (Streamlit path; see caveats)."""
    return _build_metrics(ticker, _fetch_fundamentals_default(ticker))


def _ge(v, t):
    return v is not None and v > t


def _le(v, t):
    return v is not None and v < t


# Preset screens. Each returns True if the row passes. Multi-year growth uses
# trailing growth as a proxy; industry-P/E condition is omitted (no free data).
PRESETS = {
    "PEG Screen": {
        "desc": "EPS growth > 20, Sales growth > 15, PEG < 1, D/E < 1, "
                "ROCE > 15, Market cap > ₹5000 cr.",
        "test": lambda m: (_ge(m["eps_growth"], 20) and _ge(m["sales_growth"], 15)
                           and _le(m["peg"], 1) and _le(m["de"], 1)
                           and _ge(m["roce"], 15) and _ge(m["mcap_cr"], 5000)),
    },
    "Hidden Gems": {
        "desc": "Market cap ₹500–5000 cr, Sales growth > 25, EPS growth > 25, "
                "ROCE > 20, D/E < 0.5, promoter/insider holding > 55.",
        "test": lambda m: (_le(m["mcap_cr"], 5000) and _ge(m["mcap_cr"], 500)
                           and _ge(m["sales_growth"], 25) and _ge(m["eps_growth"], 25)
                           and _ge(m["roce"], 20) and _le(m["de"], 0.5)
                           and _ge(m["promoter"], 55)),
    },
    "Growth": {
        "desc": "Market cap > ₹5000 cr, EPS growth > 20, Sales growth > 15, "
                "PEG < 1, ROCE > 18, D/E < 0.5, promoter/insider holding > 50.",
        "test": lambda m: (_ge(m["mcap_cr"], 5000) and _ge(m["eps_growth"], 20)
                           and _ge(m["sales_growth"], 15) and _le(m["peg"], 1)
                           and _ge(m["roce"], 18) and _le(m["de"], 0.5)
                           and _ge(m["promoter"], 50)),
    },
    # Cloud-data-friendly presets: filter only on market cap + P/E, which NSE
    # provides for every name even when Yahoo blocks our IP. These return rows
    # on the live deployment without any extra API key.
    "Large Cap": {
        "desc": "Market cap > ₹20,000 cr. Works on live cloud data (NSE).",
        "test": lambda m: _ge(m["mcap_cr"], 20000),
    },
    "Large Cap Value": {
        "desc": "Market cap > ₹50,000 cr and P/E < 25. Works on live data.",
        "test": lambda m: _ge(m["mcap_cr"], 50000) and _le(m["pe"], 25),
    },
}


def scan_universe(universe: list[str] | None = None,
                  max_workers: int = 12,
                  fundamentals_fn=None) -> list[dict]:
    """Fetch metrics for every ticker in the universe (skips failures).

    Parallelised — data fetch is network-bound and was the dominant cost when
    sequential. `fundamentals_fn(ticker) -> dict` lets the backend inject its
    resilient provider layer (NSE + Twelve Data + yfinance) so fields populate
    on cloud IPs where Yahoo blocks us. When None, the Streamlit default
    (yfinance + NSE, cached per ticker) is used.
    """
    from concurrent.futures import ThreadPoolExecutor
    tickers = universe or SCREEN_UNIVERSE
    if fundamentals_fn is None:
        fetch = get_metrics
    else:
        fetch = lambda t: _build_metrics(t, fundamentals_fn(t))
    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for m in pool.map(fetch, tickers):
            if m:
                rows.append(m)
    return rows


def run_preset(name: str, rows: list[dict]) -> list[dict]:
    test = PRESETS[name]["test"]
    return [m for m in rows if test(m)]


def apply_filters(rows: list[dict], filters: list[dict]) -> list[dict]:
    """filters: [{key, op ('>'|'<'), value}]; rows must pass all (AND)."""
    out = []
    for m in rows:
        ok = True
        for flt in filters:
            v = m.get(flt["key"])
            if v is None:
                ok = False
                break
            if flt["op"] == ">" and not v > flt["value"]:
                ok = False
                break
            if flt["op"] == "<" and not v < flt["value"]:
                ok = False
                break
        if ok:
            out.append(m)
    return out


# ── Value-investing screens (merged in from the old Value Investing page) ────

@st.cache_data(ttl=3600, show_spinner=False)
def buffett_screen(min_score: int = 70) -> list[dict]:
    """Rank the screen universe by Buffett-checklist score.

    Returns rows with: ticker, name, mcap_cr, score, passes, warns, fails,
    roe, pe, peg, de.  Only names with score >= min_score are returned.
    """
    from lib.value_investing import buffett_checklist

    out = []
    for t in SCREEN_UNIVERSE:
        f = get_stock_fundamentals(t)
        if not f or f.get("market_cap") is None:
            continue
        items, summary = buffett_checklist(f)
        if summary["score"] < min_score:
            continue
        out.append({
            "ticker": t.replace(".NS", ""),
            "name": f.get("name", t),
            "mcap_cr": round(f["market_cap"] / 1e7, 0),
            "score": summary["score"],
            "passes": summary["pass"],
            "warns": summary["warn"],
            "fails": summary["fail"],
            "roe": round((f.get("roe") or 0) * 100, 1) if f.get("roe") is not None else None,
            "pe": f.get("trailing_pe"),
            "peg": f.get("peg"),
            "de": f.get("debt_to_equity"),
        })
    out.sort(key=lambda r: r["score"], reverse=True)
    return out


@st.cache_data(ttl=3600, show_spinner=False)
def graham_screen(growth_default: float = 8.0, bond_yield: float = 7.0,
                  min_mos: float = 20.0) -> list[dict]:
    """Rank the screen universe by Graham margin-of-safety.

    Uses trailing-EPS growth if available, else `growth_default`.  Bond yield
    is the high-grade reference yield (India 10Y G-sec proxy by default).
    Returns names with margin_of_safety >= min_mos, sorted descending.
    """
    from lib.value_investing import graham_intrinsic_value, margin_of_safety

    out = []
    for t in SCREEN_UNIVERSE:
        f = get_stock_fundamentals(t)
        if not f:
            continue
        eps = f.get("eps_trailing")
        price = f.get("price")
        if not eps or not price or eps <= 0:
            continue
        g_raw = f.get("earnings_growth") or f.get("revenue_growth")
        growth = (g_raw * 100) if g_raw is not None else growth_default
        iv = graham_intrinsic_value(eps, growth, bond_yield)
        mos = margin_of_safety(iv, price)
        if mos is None or mos < min_mos:
            continue
        out.append({
            "ticker": t.replace(".NS", ""),
            "name": f.get("name", t),
            "price": round(price, 2),
            "intrinsic": round(iv, 2),
            "margin_of_safety": round(mos, 1),
            "eps": round(eps, 2),
            "growth_used": round(growth, 1),
            "pe": f.get("trailing_pe"),
        })
    out.sort(key=lambda r: r["margin_of_safety"], reverse=True)
    return out


# ── ETF screen ───────────────────────────────────────────────────────────────

ETF_UNIVERSE = [
    # India
    "NIFTYBEES.NS", "JUNIORBEES.NS", "BANKBEES.NS", "GOLDBEES.NS",
    "ITBEES.NS", "PSUBNKBEES.NS", "LIQUIDBEES.NS", "CPSEETF.NS",
    "ICICINIFTY.NS", "HDFCNIFTY.NS", "MAHKTECH.NS",
    # US (broad / sector)
    "SPY", "VOO", "QQQ", "VTI", "IWM", "EFA", "EEM", "XLK", "XLF",
    "XLE", "XLV", "XLY", "XLP", "XLI", "VNQ", "GLD", "SLV", "TLT",
]


@st.cache_data(ttl=3600, show_spinner=False)
def etf_screen(sort_by: str = "ytd_return", sector: str | None = None) -> list[dict]:
    """Scan the ETF universe; sort by `sort_by` desc.

    sort_by ∈ {"ytd_return", "three_year_return", "five_year_return",
              "expense_ratio_asc", "total_assets"}
    sector: substring match against the ETF category, optional.
    """
    from lib.market_data import get_etf_details, get_quote

    rows = []
    for t in ETF_UNIVERSE:
        d = get_etf_details(t)
        if not d:
            continue
        q = get_quote(t)
        er = d.get("expense_ratio")
        if er is not None and er < 1:
            er *= 100  # fraction -> percent
        rows.append({
            "ticker": t,
            "name": d.get("name", t),
            "category": d.get("category") or "—",
            "price": q.get("price"),
            "ytd_return": (d.get("ytd_return") or 0) * 100 if d.get("ytd_return") is not None else None,
            "three_year_return": (d.get("three_year_return") or 0) * 100 if d.get("three_year_return") is not None else None,
            "five_year_return": (d.get("five_year_return") or 0) * 100 if d.get("five_year_return") is not None else None,
            "expense_ratio": round(er, 2) if er is not None else None,
            "total_assets": d.get("total_assets"),
            "beta_3y": d.get("beta_3y"),
        })

    if sector:
        rows = [r for r in rows if sector.lower() in (r["category"] or "").lower()]

    if sort_by == "expense_ratio_asc":
        rows.sort(key=lambda r: (r["expense_ratio"] is None, r["expense_ratio"] or 0))
    else:
        rows.sort(key=lambda r: (r.get(sort_by) is None, -(r.get(sort_by) or 0)))

    return rows
