"""News fetching via yfinance with a Yahoo RSS fallback."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import quote_plus

import requests
import streamlit as st

from lib import news_relevance
from lib.market_data import make_ticker

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


def _parse_rss(url: str, limit: int, publisher: str | None = None) -> list[dict]:
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
        published = parse_rss_date(item.findtext("pubDate"))
        items.append({
            "title": title,
            # Google News puts the originating outlet in <source>; every
            # other feed is the outlet itself. Falling back to the feed's
            # own name beats labelling half the page "Yahoo Finance".
            "publisher": item.findtext("source") or publisher or "Yahoo Finance",
            "link": item.findtext("link") or "",
            "published": published,
            "summary": (item.findtext("description") or "").strip(),
        })
        if len(items) >= limit:
            break
    return items


def parse_rss_date(raw: str | None) -> datetime | None:
    """RFC-822-ish dates, as actually emitted by these feeds.

    Indian outlets are inconsistent here: Economic Times has shipped both
    "+0530" and "GMT", and Business Standard drops the weekday. Anything
    unparseable returns None and the item sorts to the bottom rather than
    being dropped — a headline with no timestamp is still a headline.
    """
    if not raw:
        return None
    raw = raw.strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %z",
                "%a, %d %b %Y %H:%M:%S %Z",
                "%d %b %Y %H:%M:%S %z",
                "%a, %d %b %Y %H:%M %z",
                "%Y-%m-%dT%H:%M:%S%z"):
        try:
            dt = datetime.strptime(raw, fmt)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


# Broad market feeds, tried in parallel. Indian outlets first: this is an
# India-first terminal and a market page led by US wire copy was the single
# most obvious way it didn't feel like one.
#
# Every one of these is a public RSS endpoint requiring no key. A feed that
# fails is skipped silently — one dead outlet must not empty the page.
MARKET_FEEDS: list[tuple[str, str]] = [
    ("Economic Times",
     "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"),
    ("Economic Times · Economy",
     "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms"),
    ("Business Standard",
     "https://www.business-standard.com/rss/markets-106.rss"),
    ("Livemint",
     "https://www.livemint.com/rss/markets"),
    ("Moneycontrol",
     "https://www.moneycontrol.com/rss/marketreports.xml"),
    ("Moneycontrol · Business",
     "https://www.moneycontrol.com/rss/business.xml"),
    ("The Hindu BusinessLine",
     "https://www.thehindubusinessline.com/markets/feeder/default.rss"),
    ("Yahoo Finance",
     "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^NSEI&region=IN&lang=en-IN"),
    ("CNBC Markets",
     "https://www.cnbc.com/id/20910258/device/rss/rss.html"),
]

# Feed names, for the UI's source filter. Derived from the same list so the
# filter can never offer a source the fetcher doesn't read.
MARKET_SOURCES: list[str] = [name for name, _ in MARKET_FEEDS]


_PUNCT = re.compile(r"[^a-z0-9 ]+")
_SPACE = re.compile(r"\s+")


def norm_title(title: str) -> str:
    """A comparable form of a headline.

    Wire copy reaches five outlets with five different decorations — a
    trailing " - Reuters", smart quotes, an all-caps market flag. Lowercasing
    and stripping punctuation collapses those to one string so the same story
    doesn't fill the page five times.
    """
    t = (title or "").lower()
    # Drop a trailing " - Outlet" / " | Outlet" attribution.
    t = re.split(r"\s+[-|–—]\s+(?=[a-z0-9 .&\']{2,30}$)", t)[0]
    t = _PUNCT.sub(" ", t)
    return _SPACE.sub(" ", t).strip()


def dedupe(items: list[dict]) -> list[dict]:
    """Keep the first appearance of each story.

    Order matters to the caller: pass items best-source-first, or sorted
    newest-first, and that's the copy that survives. Matching is on the
    normalised title and on the link, because syndicated copy sometimes
    keeps the URL and rewrites the headline.
    """
    seen_titles: set[str] = set()
    seen_links: set[str] = set()
    out: list[dict] = []
    for it in items:
        key = norm_title(it.get("title", ""))
        link = (it.get("link") or "").split("?")[0]
        if not key or key in seen_titles or (link and link in seen_links):
            continue
        seen_titles.add(key)
        if link:
            seen_links.add(link)
        out.append(it)
    return out


def _sort_key(item: dict):
    return item.get("published") or datetime.min.replace(tzinfo=timezone.utc)


def _newest_first(items: list[dict]) -> list[dict]:
    # Naive and aware datetimes can't be compared; the RSS parser normalises
    # to UTC, but yfinance items have been seen both ways.
    def key(it):
        dt = _sort_key(it)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return sorted(items, key=key, reverse=True)


def entity_for(ticker: str) -> dict:
    """The company identity behind a ticker, for relevance matching.

    Reads the NSE directory (symbol -> name + ISIN) so matching can use the
    real legal name and the ISIN rather than the bare symbol text. Falls back
    to a name-less entity, which downgrades matching to exact-symbol only —
    strict, but never wrong.
    """
    sym = news_relevance.bare_symbol(ticker)
    name, isin = "", ""
    try:
        from lib.resolve import _nse_directory
        meta = _nse_directory().get(sym) or {}
        name, isin = meta.get("name", ""), meta.get("isin", "")
    except Exception:
        pass
    if not name:
        # Non-Indian listings: yfinance carries a long name for most of them.
        try:
            info = make_ticker(ticker).info or {}
            name = info.get("longName") or info.get("shortName") or ""
        except Exception:
            name = ""
    return news_relevance.entity(ticker, name, isin)


@st.cache_data(ttl=600, show_spinner=False)
def ticker_news(ticker: str, limit: int = 10,
                strict: bool = True) -> list[dict]:
    """Headlines for a single ticker, filtered to that actual company.

    yfinance first (it knows which stories are tagged to the symbol), then
    Yahoo's RSS, then a Google News search. The last of those is the only
    route that reliably surfaces Indian-outlet coverage of an NSE name — and
    it is also where the wrong-company results came from, because the old
    query was the bare symbol plus the word "stock". "RELIANCE stock"
    returned Reliance Steel & Aluminum, a US metals distributor.

    Two changes fix that. The query is now the company's full name as a
    quoted phrase with an exchange qualifier, and every item — from every
    source, including yfinance's own tagging — is checked against the
    resolved entity before it is returned. Items that only match part of the
    name are dropped, and the count is reported so the caller can say so
    rather than silently showing a short list.
    """
    ent = entity_for(ticker)
    out: list[dict] = []
    try:
        raw = make_ticker(ticker).news or []
        for it in raw:
            norm = _normalize_yf_item(it)
            if norm:
                out.append(norm)
    except Exception:
        out = []

    if len(out) < limit:
        out += _parse_rss(
            f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}"
            f"&region=US&lang=en-US", limit)

    if len(out) < limit:
        query = quote_plus(news_relevance.search_query(ent))
        out += _parse_rss(
            f"https://news.google.com/rss/search?q={query}"
            f"&hl=en-IN&gl=IN&ceid=IN:en", limit, publisher="Google News")

    out = _newest_first(dedupe(out))
    if not strict or not ent["tokens"]:
        # No resolved name to match against: returning the raw list is the
        # honest option, and the caller flags it.
        return out[:limit]

    kept, dropped = news_relevance.partition(out, ent)
    for it in kept:
        it["match"] = news_relevance.match_strength(
            f"{it.get('title', '')} {it.get('summary', '')}", ent)
    _LAST_FILTER[ticker.upper()] = {
        "kept": len(kept), "dropped": len(dropped), "entity": ent["name"],
    }
    return kept[:limit]


# Last relevance-filter outcome per ticker, so the API can tell the user
# "6 headlines matched Reliance Industries; 9 mentioning other companies
# called Reliance were dropped" instead of just showing a short list.
_LAST_FILTER: dict[str, dict] = {}


def last_filter(ticker: str) -> dict:
    return _LAST_FILTER.get((ticker or "").upper(), {})


def _fetch_feed(name_url: tuple[str, str], per_feed: int) -> list[dict]:
    name, url = name_url
    items = _parse_rss(url, per_feed, publisher=name)
    for it in items:
        it["source"] = name
    return items


@st.cache_data(ttl=600, show_spinner=False)
def market_news(limit: int = 10, sources: tuple[str, ...] | None = None) -> list[dict]:
    """Aggregated market headlines across every configured feed.

    Fetched in parallel — nine sequential HTTP round trips is several seconds
    of wall clock for a page that is mostly text. Each feed is bounded by the
    same 10s timeout as everything else here, so the slowest feed sets the
    cost, not the sum.
    """
    feeds = [f for f in MARKET_FEEDS if not sources or f[0] in sources]
    if not feeds:
        return []
    per_feed = max(6, (limit * 2) // max(1, len(feeds)))

    with ThreadPoolExecutor(max_workers=min(9, len(feeds))) as pool:
        batches = list(pool.map(lambda f: _fetch_feed(f, per_feed), feeds))

    out: list[dict] = [it for batch in batches for it in batch]

    # yfinance's own aggregation, as a supplement rather than the backbone.
    for proxy in ("^NSEI", "^GSPC"):
        try:
            raw = make_ticker(proxy).news or []
        except Exception:
            continue
        for it in raw:
            norm = _normalize_yf_item(it)
            if norm:
                norm["source"] = norm.get("publisher") or "Yahoo Finance"
                out.append(norm)

    # Dedupe AFTER sorting, so the copy that survives is the most recently
    # published one rather than whichever feed happened to be first in the
    # list — an ordering that would otherwise change with the config.
    return dedupe(_newest_first(out))[:limit]
