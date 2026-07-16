"""Canonical security-identity resolution.

Every raw ticker string entering the app (URL params, search, watchlists,
portfolio, quant, alerts, the AI value-chain prompt) resolves through here
to a canonical exchange-qualified record BEFORE any data call:

    resolve("SUZLON") -> resolved  SUZLON.NS (NSE exact-symbol match)
    resolve("TCS")    -> resolved  TCS.NS    (India-first exact-symbol rule)
    resolve("AAPL")   -> resolved  AAPL      (global exact via search)
    resolve("INFOSYS")-> ambiguous [INFY.NS] (name match — user confirms)
    resolve("XQZW")   -> none

Rules (documented, deliberate):
- Already-qualified input (contains "." or starts with "^") passes through
  as canonical — the user was explicit.
- Bare symbols: NSE exact-symbol match wins FIRST (this is an India-first
  terminal; "TCS" means Tata Consultancy here, never The Container Store).
  Other exchange listings are still shown as alternates in `candidates`.
- No exact symbol anywhere -> company-NAME matching over the NSE directory
  + global search; matches become candidates for the user to pick. We never
  silently guess a name match.

Directory: NSE's official EQUITY_L.csv (symbol, company name, ISIN),
refreshed daily, with a built-in seed of major names so resolution works
even when NSE blocks the fetch (and in tests).
"""
from __future__ import annotations

from io import StringIO

import streamlit as st

# Seed subset of the NSE directory: (symbol, company name, isin).
# Used until/unless the live EQUITY_L.csv fetch succeeds.
_SEED: list[tuple[str, str, str]] = [
    ("RELIANCE", "Reliance Industries Limited", "INE002A01018"),
    ("TCS", "Tata Consultancy Services Limited", "INE467B01029"),
    ("HDFCBANK", "HDFC Bank Limited", "INE040A01034"),
    ("ICICIBANK", "ICICI Bank Limited", "INE090A01021"),
    ("INFY", "Infosys Limited", "INE009A01021"),
    ("HINDUNILVR", "Hindustan Unilever Limited", "INE030A01027"),
    ("ITC", "ITC Limited", "INE154A01025"),
    ("SBIN", "State Bank of India", "INE062A01020"),
    ("BHARTIARTL", "Bharti Airtel Limited", "INE397D01024"),
    ("KOTAKBANK", "Kotak Mahindra Bank Limited", "INE237A01028"),
    ("LT", "Larsen & Toubro Limited", "INE018A01030"),
    ("BAJFINANCE", "Bajaj Finance Limited", "INE296A01024"),
    ("AXISBANK", "Axis Bank Limited", "INE238A01034"),
    ("ASIANPAINT", "Asian Paints Limited", "INE021A01026"),
    ("MARUTI", "Maruti Suzuki India Limited", "INE585B01010"),
    ("HCLTECH", "HCL Technologies Limited", "INE860A01027"),
    ("SUNPHARMA", "Sun Pharmaceutical Industries Limited", "INE044A01036"),
    ("TITAN", "Titan Company Limited", "INE280A01028"),
    ("ULTRACEMCO", "UltraTech Cement Limited", "INE481G01011"),
    ("WIPRO", "Wipro Limited", "INE075A01022"),
    ("NESTLEIND", "Nestle India Limited", "INE239A01024"),
    ("ONGC", "Oil and Natural Gas Corporation Limited", "INE213A01029"),
    ("NTPC", "NTPC Limited", "INE733E01010"),
    ("POWERGRID", "Power Grid Corporation of India Limited", "INE752E01010"),
    ("M&M", "Mahindra and Mahindra Limited", "INE101A01026"),
    ("TATAMOTORS", "Tata Motors Limited", "INE155A01022"),
    ("TATASTEEL", "Tata Steel Limited", "INE081A01020"),
    ("TATAPOWER", "Tata Power Company Limited", "INE245A01021"),
    ("TATACONSUM", "Tata Consumer Products Limited", "INE192A01025"),
    ("TATACHEM", "Tata Chemicals Limited", "INE092A01019"),
    ("TATAELXSI", "Tata Elxsi Limited", "INE670A01012"),
    ("JSWSTEEL", "JSW Steel Limited", "INE019A01038"),
    ("ADANIENT", "Adani Enterprises Limited", "INE423A01024"),
    ("COALINDIA", "Coal India Limited", "INE522F01014"),
    ("SUZLON", "Suzlon Energy Limited", "INE040H01021"),
    ("ZOMATO", "Zomato Limited", "INE758T01015"),
    ("PAYTM", "One 97 Communications Limited", "INE982J01020"),
    ("IRCTC", "Indian Railway Catering and Tourism Corporation Limited", "INE335Y01020"),
    ("IOC", "Indian Oil Corporation Limited", "INE242A01010"),
    ("VEDL", "Vedanta Limited", "INE205A01025"),
    ("DLF", "DLF Limited", "INE271C01023"),
    ("YESBANK", "Yes Bank Limited", "INE528G01035"),
    ("IDEA", "Vodafone Idea Limited", "INE669E01016"),
]

_EQUITY_L_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"


@st.cache_data(ttl=86400, show_spinner=False)
def _nse_directory() -> dict[str, dict]:
    """{SYMBOL: {name, isin}} — live EQUITY_L.csv, seed as fallback/overlay."""
    out = {s: {"name": n, "isin": i} for s, n, i in _SEED}
    try:
        # Same Chrome-impersonation fetch pattern that works for the deals CSVs.
        from lib.deals import _fetch_csv
        import pandas as pd  # noqa: F401  (fetch returns a DataFrame)
        df = _fetch_csv(_EQUITY_L_URL)
        if df is not None and not df.empty:
            cols = {str(c).strip().upper(): c for c in df.columns}
            sym_c = cols.get("SYMBOL")
            name_c = cols.get("NAME OF COMPANY")
            isin_c = cols.get("ISIN NUMBER") or cols.get("ISIN")
            if sym_c and name_c:
                for _, r in df.iterrows():
                    sym = str(r[sym_c]).strip().upper()
                    if sym:
                        out[sym] = {
                            "name": str(r[name_c]).strip(),
                            "isin": str(r[isin_c]).strip() if isin_c else "",
                        }
    except Exception:
        pass  # seed keeps resolution functional
    return out


def _rec(symbol: str, name: str, exchange: str, isin: str = "") -> dict:
    return {"symbol": symbol, "name": name, "exchange": exchange, "isin": isin}


def directory_search(query: str, limit: int = 8) -> list[dict]:
    """Name/symbol matching over the NSE directory (prefix > substring),
    for merging into the global search endpoint."""
    q = (query or "").strip().upper()
    if len(q) < 2:
        return []
    d = _nse_directory()
    starts_sym, starts_name, contains = [], [], []
    for sym, meta in d.items():
        name_u = meta["name"].upper()
        rec = _rec(f"{sym}.NS", meta["name"], "NSE", meta.get("isin", ""))
        if sym.startswith(q):
            starts_sym.append(rec)
        elif name_u.startswith(q):
            starts_name.append(rec)
        elif q in sym or q in name_u:
            contains.append(rec)
    return (sorted(starts_sym, key=lambda r: len(r["symbol"]))
            + starts_name + contains)[:limit]


def resolve(raw: str) -> dict:
    """Resolve raw input to a canonical identity.

    Returns {status: resolved|ambiguous|none, match: rec|None,
             candidates: [rec, ...], input: raw}."""
    q = (raw or "").strip().upper()
    base = {"input": q, "match": None, "candidates": []}
    if not q:
        return {**base, "status": "none"}

    # Explicitly qualified (suffix or index) — the user told us the exchange.
    if "." in q or q.startswith("^"):
        exch = "NSE" if q.endswith(".NS") else ("BSE" if q.endswith(".BO") else "")
        d = _nse_directory()
        bare = q.split(".")[0]
        name = d.get(bare, {}).get("name", q) if exch == "NSE" else q
        isin = d.get(bare, {}).get("isin", "") if exch == "NSE" else ""
        return {**base, "status": "resolved", "match": _rec(q, name, exch, isin)}

    d = _nse_directory()

    # Rule 1: exact NSE symbol — India-first ("TCS" = Tata Consultancy here).
    if q in d:
        match = _rec(f"{q}.NS", d[q]["name"], "NSE", d[q].get("isin", ""))
        # Surface other-exchange listings of the same bare symbol as
        # alternates so nothing is hidden — but we do not guess with them.
        alts = _global_exact(q)
        return {**base, "status": "resolved", "match": match,
                "candidates": [c for c in alts if c["symbol"] != match["symbol"]][:4]}

    # Rule 2: exact symbol on a global exchange (AAPL, MSFT, ^GSPC…).
    exact = _global_exact(q)
    if len(exact) == 1:
        return {**base, "status": "resolved", "match": exact[0]}
    if len(exact) > 1:
        return {**base, "status": "ambiguous", "candidates": exact[:6]}

    # Rule 3: NAME matching — never auto-picked, always user-confirmed.
    cands = directory_search(q, limit=5)
    try:
        from lib.search import search_securities
        for h in search_securities(q, limit=5):
            if not any(c["symbol"] == h["symbol"] for c in cands):
                cands.append(_rec(h["symbol"], h["name"], h.get("exchange", "")))
    except Exception:
        pass
    if cands:
        return {**base, "status": "ambiguous", "candidates": cands[:6]}
    return {**base, "status": "none"}


def _global_exact(q: str) -> list[dict]:
    """Exact bare-symbol matches from the global (Yahoo) search."""
    try:
        from lib.search import search_securities
        hits = search_securities(q, limit=8)
    except Exception:
        return []
    return [_rec(h["symbol"], h["name"], h.get("exchange", ""))
            for h in hits if h["symbol"].upper() == q]


def canonicalize(raw: str) -> str | None:
    """Convenience for server-side normalization on save paths (watchlists,
    portfolio, alerts): canonical symbol when confidently resolved, the
    qualified input as-is, or None when it needs user disambiguation."""
    r = resolve(raw)
    if r["status"] == "resolved" and r["match"]:
        return r["match"]["symbol"]
    return None
