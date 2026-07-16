"""Sector + exchange peer selection for the Comparables matrix.

Free data has no "give me comparable companies" API, so peers come from a
curated map keyed by (market, sector-keyword). The subject's market comes
from its ticker suffix, its sector from the provider snapshot; matching is
keyword-based because every provider spells sectors differently (yfinance
"Technology" vs NSE "Information Technology" etc.). Falls back to the
market's mega-cap default set when the sector is unknown — never to peers
from the wrong exchange (the old behavior compared AAPL to Indian IT).
"""
from __future__ import annotations

# (keywords that identify the sector) -> peer list, per market.
_IN_GROUPS: list[tuple[tuple[str, ...], list[str]]] = [
    (("information technology", "it services", "software", "technology"),
     ["TCS.NS", "INFY.NS", "HCLTECH.NS", "WIPRO.NS", "TECHM.NS"]),
    (("bank",),
     ["HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "KOTAKBANK.NS", "AXISBANK.NS"]),
    (("financial", "nbfc", "finance", "insurance"),
     ["BAJFINANCE.NS", "BAJAJFINSV.NS", "SBILIFE.NS", "HDFCLIFE.NS", "MUTHOOTFIN.NS"]),
    (("oil", "gas", "energy", "petroleum", "refin"),
     ["RELIANCE.NS", "ONGC.NS", "BPCL.NS", "COALINDIA.NS", "NTPC.NS"]),
    (("fmcg", "consumer goods", "consumer defensive", "food", "beverage"),
     ["HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "BRITANNIA.NS", "DABUR.NS"]),
    (("pharma", "healthcare", "drug", "hospital", "diagnostic"),
     ["SUNPHARMA.NS", "CIPLA.NS", "DRREDDY.NS", "DIVISLAB.NS", "APOLLOHOSP.NS"]),
    (("auto", "automobile", "vehicle"),
     ["MARUTI.NS", "M&M.NS", "TATAMOTORS.NS", "EICHERMOT.NS", "HEROMOTOCO.NS"]),
    (("metal", "mining", "steel", "aluminium"),
     ["TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS", "VEDL.NS", "COALINDIA.NS"]),
    (("cement", "construction", "infrastructure", "engineering"),
     ["ULTRACEMCO.NS", "GRASIM.NS", "LT.NS", "ASTRAL.NS", "POLYCAB.NS"]),
    (("retail", "consumer services", "consumer durables", "apparel", "jewell"),
     ["TITAN.NS", "TRENT.NS", "RELAXO.NS", "PAGEIND.NS", "JUBLFOOD.NS"]),
    (("telecom", "communication"),
     ["BHARTIARTL.NS", "RELIANCE.NS", "TCS.NS", "HCLTECH.NS"]),
    (("chemical", "fertiliz", "paint"),
     ["ASIANPAINT.NS", "PIDILITIND.NS", "DEEPAKNTR.NS", "AARTIIND.NS", "VINATIORGA.NS"]),
    (("power", "utilit",),
     ["NTPC.NS", "POWERGRID.NS", "COALINDIA.NS", "ONGC.NS"]),
]

_US_GROUPS: list[tuple[tuple[str, ...], list[str]]] = [
    (("technology", "software", "semiconductor", "information technology"),
     ["AAPL", "MSFT", "GOOGL", "NVDA", "META"]),
    (("communication",),
     ["GOOGL", "META", "NFLX", "DIS", "TMUS"]),
    (("consumer cyclical", "consumer discretionary", "retail", "auto"),
     ["AMZN", "TSLA", "HD", "NKE", "MCD"]),
    (("financial", "bank", "insurance", "capital markets"),
     ["JPM", "BAC", "WFC", "GS", "MS"]),
    (("healthcare", "pharma", "biotech", "drug"),
     ["JNJ", "UNH", "LLY", "PFE", "MRK"]),
    (("energy", "oil", "gas"),
     ["XOM", "CVX", "COP", "SLB", "EOG"]),
    (("consumer defensive", "consumer staples", "food", "beverage"),
     ["PG", "KO", "PEP", "WMT", "COST"]),
    (("industrial", "aerospace", "machinery"),
     ["CAT", "BA", "HON", "UPS", "GE"]),
    (("real estate", "reit"),
     ["PLD", "AMT", "EQIX", "SPG"]),
    (("utilit",),
     ["NEE", "DUK", "SO", "D"]),
    (("basic materials", "materials", "chemical", "mining"),
     ["LIN", "APD", "FCX", "NEM"]),
]

_IN_DEFAULT = ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS"]
_US_DEFAULT = ["AAPL", "MSFT", "GOOGL", "AMZN"]


def _market(ticker: str) -> str:
    t = ticker.upper()
    return "IN" if (t.endswith(".NS") or t.endswith(".BO")) else "US"


def get_peers(ticker: str, sector: str | None) -> dict:
    """Return {peers, sector, basis} — subject first, ≤5 unique peers total."""
    t = ticker.upper()
    market = _market(t)
    groups = _IN_GROUPS if market == "IN" else _US_GROUPS
    default = _IN_DEFAULT if market == "IN" else _US_DEFAULT

    chosen: list[str] | None = None
    basis = "exchange-default"
    s = (sector or "").lower()
    if s:
        for keywords, peers in groups:
            if any(k in s for k in keywords):
                chosen = peers
                basis = "sector+exchange"
                break
    if chosen is None:
        chosen = default

    out = [t]
    for p in chosen:
        if p.upper() != t and p not in out:
            out.append(p)
        if len(out) >= 5:
            break
    return {"peers": out, "sector": sector, "basis": basis, "market": market}
