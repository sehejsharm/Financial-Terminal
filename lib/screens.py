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
    # Genuine mid/small caps so band-limited presets ("Hidden Gems",
    # ₹500–5000 cr) have candidates — the original universe was almost
    # entirely large-cap, so those presets could never match anything.
    "KPITTECH.NS", "TANLA.NS", "ROUTE.NS", "MAPMYINDIA.NS", "LATENTVIEW.NS",
    "HAPPSTMNDS.NS", "INTELLECT.NS", "BIRLASOFT.NS", "ZENSARTECH.NS",
    "SONATSOFTW.NS", "MASTEK.NS", "NEWGEN.NS", "RATEGAIN.NS", "TEJASNET.NS",
    "VGUARD.NS", "POLYMED.NS", "FINEORG.NS", "CLEAN.NS", "SUPRAJIT.NS",
    "CERA.NS", "VIPIND.NS", "CAMPUS.NS", "SAPPHIRE.NS", "DEVYANI.NS",
    "WESTLIFE.NS", "GOCOLORS.NS", "ETHOSLTD.NS", "JYOTHYLAB.NS", "EMAMILTD.NS",
    "GRINDWELL.NS",
]

# Metrics available per the filter UI: (label, key, unit).
FILTER_METRICS = [
    ("Market cap (₹ cr)", "mcap_cr", "cr"),
    ("EPS growth (%)", "eps_growth", "%"),
    ("Sales growth (%)", "sales_growth", "%"),
    ("PEG ratio", "peg", ""),
    ("Debt / Equity", "de", ""),
    ("ROCE (%)", "roce", "%"),
    ("Promoter/insider holding (%)", "promoter", "%"),
    ("P/E", "pe", ""),
    ("ROE (%)", "roe", "%"),
]


def enrich_indian(ticker: str, f: dict) -> dict:
    """Fill the fields the free feed leaves blank for Indian listings.

    PEG, Hidden Gems and Growth all filter on growth, ROCE and promoter
    holding. No free non-Indian provider carries any of the three for NSE
    names, so `_ge(None, x)` was False on every row and those three presets
    could never match a single company — they were not "empty screens", they
    were screens that could not run.

    NSE publishes all three itself: results filings give growth, the filing's
    own EBIT and the balance-sheet lines give nothing (the feed has no balance
    sheet), and the shareholding pattern gives the promoter stake. Only what is
    genuinely derivable is filled; the rest stays None so the coverage report
    can say the screen is unrunnable rather than returning a silent zero.
    """
    from lib import nse_financials as nf

    out = dict(f)
    try:
        # One document per HTTP fetch, and this runs per ticker across a whole
        # universe — five documents each would turn a screen into minutes of
        # requests. Two is enough for year-on-year growth, because a filing's
        # XBRL carries its own quarter and the year-ago comparative together.
        parsed = nf.financial_results(ticker, quarterly=True, max_docs=2)
    except Exception:
        parsed = {"columns": [], "rows": []}

    if parsed.get("rows"):
        if out.get("revenue_growth") is None:
            g = nf.yoy_growth(parsed, "Revenue")
            # The rest of the pipeline expects provider FRACTIONS (0.184),
            # and yoy_growth returns percent.
            if g is not None:
                out["revenue_growth"] = g / 100
        if out.get("earnings_growth") is None:
            g = nf.yoy_growth(parsed, "Net Income")
            if g is not None:
                out["earnings_growth"] = g / 100
        if out.get("revenue") is None:
            ttm = nf.trailing_twelve(parsed, "Revenue")
            if ttm is not None:
                out["revenue"] = ttm

    if out.get("held_insiders") is None:
        try:
            promoter = nf.promoter_holding(ticker)
        except Exception:
            promoter = None
        if promoter is not None:
            out["held_insiders"] = promoter / 100      # fraction, as above

    return out


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
        f = enrich_indian(ticker, f)
    return f



# ── unit declarations for percent fields ──────────────────────────────────
#
# Which unit each provider field ARRIVES in. This table is the fix for defect
# #15: `pct()` used to assume every field was a fraction, which is true of the
# margins and false of dividend yield.
#
# A field in neither set raises rather than defaulting, so adding a percent
# column forces a decision instead of inheriting an assumption.
_ARRIVES_AS_FRACTION = frozenset({
    "profit_margin", "operating_margin", "gross_margin",
})
_ARRIVES_AS_PERCENT = frozenset({
    # yfinance and FMP both express this as a percent already.
    "dividend_yield",
})

# Crore is an INR convention: 1 crore = 1e7 rupees. Applying it to a figure
# reported in another currency reports that currency as rupees.
_RUPEES_PER_CRORE = 1e7

# Approximate FX, used ONLY to bring a foreign-currency revenue onto the same
# scale as an INR market cap so the row is not wrong by ~88x.
#
# THIS IS NOT A LIVE RATE AND SHOULD NOT BE ONE DAY'S TRUTH. It is here because
# the alternative was worse: the audit saw INFY revenue rendered as 2,030 Cr
# against an actual ~1.6 lakh crore, which propagated into a P/S of 208.87 —
# and since the screener sorts on P/S, the broken rows sorted to the top, which
# is the worst possible place for them. An approximate conversion that is right
# to within a few percent beats an error of two orders of magnitude.
#
# The proper fix is a live FX source; until then the row declares the currency
# AND that the figure was converted, so a reader is never told a converted
# number is native.
_APPROX_INR_PER = {
    "USD": 88.0,
    "EUR": 95.0,
    "GBP": 112.0,
}


def _reporting_currency(f: dict) -> str:
    """The currency the INCOME STATEMENT is reported in.

    Deliberately not the same question as "what currency is the share price
    in". An NSE listing is priced in INR and may report financials in USD —
    Infosys and HCL Tech both do — and conflating the two is the whole of
    defect #14. Providers use several key names for this, so check all of them
    before falling back.
    """
    for key in ("financial_currency", "financialCurrency",
                "reporting_currency", "currency"):
        v = f.get(key)
        if isinstance(v, str) and len(v) == 3:
            return v.upper()
    return "INR"


def _implied_foreign(f: dict) -> bool:
    """True when revenue is clearly not on the same scale as the market cap.

    A fallback for the common case where the provider does not say which
    currency it reported in. The test is self-consistency rather than a guess
    about the company: revenue per share and share price are normally within an
    order of magnitude or two of each other, because both are per-share figures
    in the listing currency. When they are three or more apart, the two numbers
    are not in the same unit — which is exactly the signal the INV-05 invariant
    checks for.

    Used only to DECIDE WHETHER TO LOOK for a conversion; it never invents one.
    """
    revenue, mcap, price = f.get("revenue"), f.get("market_cap"), f.get("price")
    if not all(isinstance(v, (int, float)) and v for v in (revenue, mcap, price)):
        return False
    shares = mcap / price
    if shares <= 0:
        return False
    rps = revenue / shares
    # Three orders of magnitude is well clear of any real dispersion in
    # revenue-per-share, and comfortably inside the ~88x an FX mismatch gives.
    return rps > 0 and (price / rps) > 100


def _money_in_crore(f: dict) -> tuple[str, float | None, float | None]:
    """(currency, revenue in crore, free cash flow in crore).

    DEFECT #14: this used to be `round(f["revenue"] / 1e7, 0)` with no regard
    for what currency the figure was in, and no currency on the way out.
    """
    declared = _reporting_currency(f)
    ccy = declared
    rate = 1.0

    if declared != "INR":
        rate = _APPROX_INR_PER.get(declared, 1.0)
    elif _implied_foreign(f):
        # The provider claimed INR (or said nothing) but the numbers disagree.
        # Assume USD, which is what every observed case was, and say so.
        ccy, rate = "USD", _APPROX_INR_PER["USD"]

    def to_cr(key):
        v = f.get(key)
        if not isinstance(v, (int, float)):
            return None
        return round(v * rate / _RUPEES_PER_CRORE, 0)

    # The currency reported is INR once converted — that is what "Cr" means.
    # Reporting the SOURCE currency here instead would be the same mistake in
    # reverse: a reader would apply the conversion twice.
    out_ccy = "INR" if rate != 1.0 else ccy
    return out_ccy, to_cr("revenue"), to_cr("free_cashflow")


from lib import beta as _beta


def _build_metrics(ticker: str, f: dict | None) -> dict | None:
    """Pure transform: raw fundamentals dict -> screen metric row. No network."""
    f = f or {}
    if not f or f.get("market_cap") is None:
        return None
    mcap_cr = f["market_cap"] / 1e7  # INR -> crore
    eps_g = (f.get("earnings_growth") or 0) * 100 if f.get("earnings_growth") is not None else None
    sales_g = (f.get("revenue_growth") or 0) * 100 if f.get("revenue_growth") is not None else None
    # ── units and currency ────────────────────────────────────────────────
    #
    # Every bug in this area is the same bug: a number arrives already carrying
    # a unit and the code applies the unit again. Nobody notices because the
    # result is still a plausible-looking number in a column full of
    # plausible-looking numbers.
    reporting_ccy, revenue_cr, fcf_cr = _money_in_crore(f)

    # ROCE only when a provider actually supplies it (FMP key-metrics). The
    # old ROE fallback made the ROCE column an exact ROE duplicate for every
    # row — worse than showing "—", since they differ materially (banks vs
    # manufacturers) and screens filtered on the wrong metric.
    roce = f.get("roce")
    roce = roce * 100 if roce is not None else None
    roe = (f.get("roe") or 0) * 100 if f.get("roe") is not None else None
    de = f.get("debt_to_equity")
    de = de / 100 if de is not None else None  # percentage -> ratio
    promoter = (f.get("held_insiders") or 0) * 100 if f.get("held_insiders") is not None else None

    # PEG = P/E over earnings growth. Providers rarely populate it for NSE
    # names even when both inputs are present, and it gates two presets.
    # Negative growth has no PEG — a negative ratio would sort as "cheap".
    peg = f.get("peg")
    if peg is None:
        pe_raw = f.get("trailing_pe")
        if isinstance(pe_raw, (int, float)) and eps_g is not None and eps_g > 0:
            peg = round(pe_raw / eps_g, 2)

    def pct(key):
        """A percent, whatever unit the provider happened to use.

        DEFECT #15 WAS HERE, and it was one assumption: that every field
        arrives as a fraction. Margins do (0.184 means 18.4%). Dividend yield
        does NOT — the providers in use hand it over already expressed as a
        percent, so multiplying again rendered a 0.48% yield as 48%, and the
        audit saw 48 / 297 / 606 in the DIV YIELD column while DES rendered the
        same Reliance figure correctly as 0.48%. Both read the same provider
        field; only one of them multiplied.

        So the unit is now declared per field rather than assumed, and an
        undeclared field RAISES instead of inheriting a guess. That is
        deliberate: the next person to add a percent column has to say which
        unit it arrives in, which is the only thing that stops this recurring.
        """
        v = f.get(key)
        if not isinstance(v, (int, float)):
            return None
        if key in _ARRIVES_AS_FRACTION:
            v = v * 100
        elif key not in _ARRIVES_AS_PERCENT:
            raise KeyError(
                f"{key!r} has no declared unit — add it to _ARRIVES_AS_FRACTION "
                "or _ARRIVES_AS_PERCENT in lib/screens.py. Guessing is what "
                "defect #15 was.")
        return round(v, 2)

    def num(key, digits=2):
        v = f.get(key)
        return round(float(v), digits) if isinstance(v, (int, float)) else None

    price = num("price")
    hi52, lo52 = num("fifty_two_high"), num("fifty_two_low")
    ma50, ma200 = num("fifty_day_avg"), num("two_hundred_day_avg")

    # Position within the 52-week range, 0-100. A derived field, but derived
    # from two published numbers rather than estimated.
    pos52 = None
    if price is not None and hi52 is not None and lo52 is not None and hi52 > lo52:
        pos52 = round(((price - lo52) / (hi52 - lo52)) * 100, 1)

    def vs(ma):
        return round(((price - ma) / ma) * 100, 1) \
            if price is not None and ma not in (None, 0) else None

    return {
        "ticker": ticker.replace(".NS", ""),
        "name": f.get("name", ticker),
        "sector": f.get("sector") or None,
        "industry": f.get("industry") or None,
        # ── size & price ──
        "mcap_cr": round(mcap_cr, 0),
        "price": price,
        "change_pct": num("change_pct"),
        "pos_52w": pos52,
        "vs_50d": vs(ma50),
        "vs_200d": vs(ma200),
        # ── valuation ──
        "pe": f.get("trailing_pe"),
        "forward_pe": num("forward_pe"),
        "peg": peg,
        "pb": num("price_to_book"),
        "ps": num("price_to_sales"),
        # ── growth ──
        "eps_growth": round(eps_g, 1) if eps_g is not None else None,
        "sales_growth": round(sales_g, 1) if sales_g is not None else None,
        # ── quality / returns ──
        "roce": round(roce, 1) if roce is not None else None,
        "roe": round(roe, 1) if roe is not None else None,
        "profit_margin": pct("profit_margin"),
        "operating_margin": pct("operating_margin"),
        "gross_margin": pct("gross_margin"),
        # ── balance sheet ──
        "de": round(de, 2) if de is not None else None,
        "current_ratio": num("current_ratio"),
        # ── income / cash ──
        "revenue_cr": revenue_cr,
        "fcf_cr": fcf_cr,
        # DEFECT #14/#32: money fields used to travel as bare numbers, so a
        # renderer could not know whether to print a rupee sign and defaulted
        # to the sibling field's. Every row now declares the currency its
        # crore figures are in.
        "currency": reporting_ccy,
        "revenue_currency": reporting_ccy,
        # ── other ──
        "div_yield": pct("dividend_yield"),
        # DEFECT #11: this used to be the provider's number verbatim, and
        # those vendors regress an NSE listing against their own benchmark.
        # sanitise_provider_beta drops anything the INV-06 band calls
        # impossible, so a 0.00 or a -0.09 becomes a dash instead of flowing
        # into CAPM -> WACC -> a printed verdict. See lib/beta.py.
        "beta": _beta.sanitise_provider_beta(f.get("beta")),
        # So a consumer can tell a regression we ran from one we inherited.
        "beta_source": "provider" if f.get("beta") is not None else None,
        "promoter": round(promoter, 1) if promoter is not None else None,
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
# The metric each preset depends on. A screen whose gating field is empty for
# the whole universe cannot run — which is a different statement from "nothing
# matched", and the one the reader needs.
PRESET_REQUIRES: dict[str, tuple[str, ...]] = {
    "PEG Screen": ("eps_growth", "sales_growth", "peg", "de", "roce", "mcap_cr"),
    "Hidden Gems": ("mcap_cr", "sales_growth", "eps_growth", "roce", "de", "promoter"),
    "Growth": ("mcap_cr", "eps_growth", "sales_growth", "peg", "roce", "de", "promoter"),
    "Large Cap": ("mcap_cr",),
    "Large Cap Value": ("mcap_cr", "pe"),
}


def field_coverage(rows: list[dict], keys) -> dict[str, int]:
    """How many rows carry a usable value for each key."""
    return {k: sum(1 for r in rows if r.get(k) is not None) for k in keys}


def unrunnable_fields(rows: list[dict], name: str) -> list[str]:
    """Fields this preset filters on that NO scanned row can supply.

    Every one of these makes the preset's test False for every company, so a
    screen with any of them returns nothing regardless of the market.
    """
    if not rows:
        return []
    cov = field_coverage(rows, PRESET_REQUIRES.get(name, ()))
    return [k for k, n in cov.items() if n == 0]


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


# Every filterable field, with the label and unit the UI shows. Declared here
# so the backend, the UI and the coverage report can't drift apart.
FIELDS: list[dict] = [
    {"key": "mcap_cr", "label": "Market cap", "unit": "₹cr", "group": "Size"},
    {"key": "price", "label": "Price", "unit": "", "group": "Size"},
    {"key": "change_pct", "label": "Change today", "unit": "%", "group": "Size"},
    {"key": "revenue_cr", "label": "Revenue", "unit": "₹cr", "group": "Size"},

    {"key": "pe", "label": "P/E (trailing)", "unit": "x", "group": "Valuation"},
    {"key": "forward_pe", "label": "P/E (forward)", "unit": "x", "group": "Valuation"},
    {"key": "peg", "label": "PEG", "unit": "x", "group": "Valuation"},
    {"key": "pb", "label": "Price / book", "unit": "x", "group": "Valuation"},
    {"key": "ps", "label": "Price / sales", "unit": "x", "group": "Valuation"},
    {"key": "div_yield", "label": "Dividend yield", "unit": "%", "group": "Valuation"},

    {"key": "eps_growth", "label": "EPS growth", "unit": "%", "group": "Growth"},
    {"key": "sales_growth", "label": "Sales growth", "unit": "%", "group": "Growth"},

    {"key": "roce", "label": "ROCE", "unit": "%", "group": "Quality"},
    {"key": "roe", "label": "ROE", "unit": "%", "group": "Quality"},
    {"key": "profit_margin", "label": "Profit margin", "unit": "%", "group": "Quality"},
    {"key": "operating_margin", "label": "Operating margin", "unit": "%", "group": "Quality"},
    {"key": "gross_margin", "label": "Gross margin", "unit": "%", "group": "Quality"},
    {"key": "fcf_cr", "label": "Free cash flow", "unit": "₹cr", "group": "Quality"},

    {"key": "de", "label": "Debt / equity", "unit": "x", "group": "Balance sheet"},
    {"key": "current_ratio", "label": "Current ratio", "unit": "x", "group": "Balance sheet"},
    {"key": "promoter", "label": "Promoter holding", "unit": "%", "group": "Balance sheet"},

    {"key": "pos_52w", "label": "52w range position", "unit": "%", "group": "Technicals"},
    {"key": "vs_50d", "label": "vs 50-day avg", "unit": "%", "group": "Technicals"},
    {"key": "vs_200d", "label": "vs 200-day avg", "unit": "%", "group": "Technicals"},
    {"key": "beta", "label": "Beta", "unit": "", "group": "Technicals"},
]

FIELD_KEYS = {f["key"] for f in FIELDS}

# Comparison operators. "between" takes value + value2.
OPS = {">", ">=", "<", "<=", "=", "between"}


def _passes(v, op: str, a, b=None) -> bool:
    """One comparison. A missing value never passes — a screen must not
    silently treat "unknown" as "meets the criterion"."""
    if v is None or a is None:
        return False
    try:
        v = float(v); a = float(a)
    except (TypeError, ValueError):
        return False
    if op == ">":
        return v > a
    if op == ">=":
        return v >= a
    if op == "<":
        return v < a
    if op == "<=":
        return v <= a
    if op == "=":
        # Floats: compare with a tolerance rather than exact equality, which
        # would essentially never match a computed ratio.
        return abs(v - a) <= max(abs(a) * 1e-6, 1e-9)
    if op == "between":
        if b is None:
            return False
        try:
            b = float(b)
        except (TypeError, ValueError):
            return False
        lo, hi = (a, b) if a <= b else (b, a)
        return lo <= v <= hi
    return False


def apply_filters(rows: list[dict], filters: list[dict],
                  match: str = "all", sectors: list[str] | None = None) -> list[dict]:
    """Filter rows.

    filters: [{key, op, value, value2?}]
    match:   "all" (AND) or "any" (OR) across the filters
    sectors: keep only these sectors when given
    """
    want = {s for s in (sectors or []) if s}
    out = []
    for m in rows:
        if want and (m.get("sector") or "") not in want:
            continue
        if not filters:
            out.append(m)
            continue
        results = [
            _passes(m.get(f.get("key")), f.get("op", ">"), f.get("value"), f.get("value2"))
            for f in filters
        ]
        if (all(results) if match != "any" else any(results)):
            out.append(m)
    return out


def coverage(rows: list[dict]) -> dict[str, int]:
    """How many scanned names actually carry each field.

    Surfaced in the UI because it explains the single most confusing screener
    outcome: a filter on a field the free providers barely populate returns
    nothing, and without this it looks like no company qualifies rather than
    like the data isn't there.
    """
    out: dict[str, int] = {}
    for f in FIELDS:
        k = f["key"]
        out[k] = sum(1 for m in rows if m.get(k) is not None)
    return out


def sectors_in(rows: list[dict]) -> list[str]:
    return sorted({(m.get("sector") or "").strip() for m in rows if m.get("sector")})


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
