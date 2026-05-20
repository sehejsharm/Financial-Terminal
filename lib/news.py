"""News fetching via yfinance with a Yahoo RSS fallback."""
from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests
import streamlit as st
import yfinance as yf

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; StockMarketAnalyst/1.0)"}


def time_ago(dt: datetime | None) -> str:
    if dt is None:
        return ""
    now = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = now - dt
    secs = delta.total_seconds()
    if secs < 0:
        return "just now"
    if secs < 3600:
        return f"{int(secs // 60)}m ago"
    if secs < 86400:
        return f"{int(secs // 3600)}h ago"
    return f"{int(secs // 86400)}d ago"


def _normalize_yf_item(item: dict) -> dict | None:
    """yfinance news items have changed shape across versions; handle both."""
    content = item.get("content", item)
    title = content.get("title") or item.get("title")
    if not title:
        return None
    publisher = (
        (content.get("provider") or {}).get("displayName")
        if isinstance(content.get("provider"), dict)
        else item.get("publisher")
    ) or "Yahoo Finance"
    summary = content.get("summary") or content.get("description") or ""
    link = (
        (content.get("canonicalUrl") or {}).get("url")
        if isinstance(content.get("canonicalUrl"), dict)
        else item.get("link")
    ) or item.get("link", "")

    published = None
    ts = item.get("providerPublishTime")
    if ts:
        published = datetime.fromtimestamp(ts, tz=timezone.utc)
    else:
        pub = content.get("pubDate") or content.get("displayTime")
        if pub:
            try:
                published = datetime.fromisoformat(pub.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                published = None

    return {
        "title": title,
        "publisher": publisher,
        "link": link,
        "published": published,
        "summary": summary,
    }


def _parse_rss(url: str, limit: int) -> list[dict]:
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=10)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
    except Exception:
        return []
    items: list[dict] = []
    for item in root.iter("item"):
        title = item.findtext("title")
        if not title:
            continue
        pub_raw = item.findtext("pubDate")
        published = None
        if pub_raw:
            for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z"):
                try:
                    published = datetime.strptime(pub_raw, fmt)
                    break
                except ValueError:
                    continue
        items.append({
            "title": title,
            "publisher": item.findtext("source") or "Yahoo Finance",
            "link": item.findtext("link") or "",
            "published": published,
            "summary": (item.findtext("description") or "").strip(),
        })
        if len(items) >= limit:
            break
    return items


@st.cache_data(ttl=600, show_spinner=False)
def ticker_news(ticker: str, limit: int = 10) -> list[dict]:
    """Headlines for a single ticker."""
    out: list[dict] = []
    try:
        raw = yf.Ticker(ticker).news or []
        for it in raw:
            norm = _normalize_yf_item(it)
            if norm:
                out.append(norm)
    except Exception:
        out = []

    if not out:
        url = (f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}"
               f"&region=US&lang=en-US")
        out = _parse_rss(url, limit)

    out.sort(key=lambda x: x.get("published") or datetime.min.replace(tzinfo=timezone.utc),
             reverse=True)
    return out[:limit]


@st.cache_data(ttl=600, show_spinner=False)
def market_news(limit: int = 10) -> list[dict]:
    """Aggregated market headlines from a few broad tickers + RSS fallback."""
    out: list[dict] = []
    seen: set[str] = set()
    for proxy in ("SPY", "^GSPC", "QQQ"):
        try:
            raw = yf.Ticker(proxy).news or []
        except Exception:
            raw = []
        for it in raw:
            norm = _normalize_yf_item(it)
            if norm and norm["title"] not in seen:
                seen.add(norm["title"])
                out.append(norm)

    if len(out) < limit:
        for it in _parse_rss(
            "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US",
            limit,
        ):
            if it["title"] not in seen:
                seen.add(it["title"])
                out.append(it)

    out.sort(key=lambda x: x.get("published") or datetime.min.replace(tzinfo=timezone.utc),
             reverse=True)
    return out[:limit]
