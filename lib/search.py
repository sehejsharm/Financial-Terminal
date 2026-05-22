"""Security search / autocomplete via Yahoo's public search endpoint.

Returns matching symbols across global exchanges so the UI can offer a
typeahead-style dropdown instead of forcing exact tickers.
"""
from __future__ import annotations

import requests
import streamlit as st

_URL = "https://query2.finance.yahoo.com/v1/finance/search"
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; Motherboard/1.0)"}

# Small offline catalog so the picker still suggests something if the network
# search is blocked.
_CATALOG = [
    ("^NSEI", "NIFTY 50"), ("^BSESN", "SENSEX"), ("^NSEBANK", "NIFTY Bank"),
    ("RELIANCE.NS", "Reliance Industries"), ("TCS.NS", "Tata Consultancy"),
    ("HDFCBANK.NS", "HDFC Bank"), ("ICICIBANK.NS", "ICICI Bank"),
    ("INFY.NS", "Infosys"), ("ITC.NS", "ITC"), ("SBIN.NS", "State Bank of India"),
    ("BHARTIARTL.NS", "Bharti Airtel"), ("LT.NS", "Larsen & Toubro"),
    ("AAPL", "Apple"), ("MSFT", "Microsoft"), ("NVDA", "NVIDIA"),
    ("GOOGL", "Alphabet"), ("AMZN", "Amazon"), ("TSLA", "Tesla"),
    ("META", "Meta Platforms"), ("SPY", "S&P 500 ETF"), ("QQQ", "Nasdaq 100 ETF"),
]


@st.cache_data(ttl=600, show_spinner=False)
def search_securities(query: str, limit: int = 8) -> list[dict]:
    """Return [{symbol, name, exchange, type}] matching the query."""
    query = (query or "").strip()
    if len(query) < 2:
        return []
    try:
        resp = requests.get(
            _URL, params={"q": query, "quotesCount": limit, "newsCount": 0},
            headers=_HEADERS, timeout=8,
        )
        resp.raise_for_status()
        quotes = resp.json().get("quotes", [])
        out = []
        for q in quotes:
            sym = q.get("symbol")
            if not sym:
                continue
            out.append({
                "symbol": sym,
                "name": q.get("shortname") or q.get("longname") or sym,
                "exchange": q.get("exchDisp") or q.get("exchange") or "",
                "type": q.get("quoteType") or "",
            })
        if out:
            return out[:limit]
    except Exception:
        pass

    # Offline fallback: substring match against the catalog.
    ql = query.lower()
    return [
        {"symbol": s, "name": n, "exchange": "", "type": ""}
        for s, n in _CATALOG if ql in s.lower() or ql in n.lower()
    ][:limit]
