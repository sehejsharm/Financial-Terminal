"""Deciding whether a headline is actually about the company you asked for.

The bug this exists to fix: asking for RELIANCE.NS returned stories about
Reliance Steel & Aluminum (NYSE: RS), a completely unrelated American metals
distributor. The old path searched news for the bare symbol text — "RELIANCE
stock" — and any outlet writing about any company called Reliance matched.

The fix is to stop matching on a name fragment. A headline qualifies only if
it carries one of:

  * an exchange-qualified symbol   — RELIANCE.NS, NSE: RELIANCE, (NSE:RELIANCE)
  * the ISIN                       — INE002A01018
  * the full distinctive name      — every token of "Reliance Industries",
                                     not just the first one

"Reliance" alone is not enough, and that single rule kills the reported bug:
Reliance Steel has "reliance" but never "industries". Where a company's whole
distinctive name IS one common word — Titan, Vedanta, Apollo — that word alone
still isn't enough; the story also has to carry an Indian-market marker, or a
US namesake sails straight through.

Deliberately biased towards dropping. A missing headline is a smaller
failure than a headline about the wrong company presented as this company's
news, because the second one gets acted on.
"""
from __future__ import annotations

import re

# Stripped before matching: they carry no identity. "Reliance Industries
# Limited" and "Reliance Industries Ltd." are the same company, and neither
# is distinguished from anything by the word "limited".
LEGAL_SUFFIXES = {
    "limited", "ltd", "inc", "incorporated", "corp", "corporation", "plc",
    "company", "co", "llc", "llp", "lp", "sa", "nv", "ag", "gmbh", "spa",
    "holdings", "holding", "group", "the", "and", "of",
}

# Words that are a whole Indian company's distinctive name AND a common word
# or a foreign company's name. These require an Indian-market marker in the
# story before the match counts.
#
# The test for inclusion is concrete: is there a listed company somewhere
# else whose name is this word? Titan Pharmaceuticals, Apollo Global
# Management, Vedanta Resources, Century Communities, Orient Overseas.
AMBIGUOUS_SINGLE_TOKENS = {
    "titan", "apollo", "vedanta", "century", "orient", "prism", "sun",
    "hero", "jubilant", "trent", "page", "astral", "relaxo", "clean",
    "campus", "route", "delta", "force", "sterling", "everest",
    "national", "premier", "supreme", "india", "indian", "asian",
    "global", "united", "general",
}

INDIA_MARKERS = re.compile(
    r"\b(nse|bse|nifty|sensex|rupee|rupees|india|indian|mumbai|sebi|rbi|"
    r"crore|crores|lakh|lakhs|dalal street|nseindia)\b|₹|rs\.?\s?\d")

# Foreign namesakes that share a leading token with an Indian listing.
# A story matching one of these is dropped outright, even if it would
# otherwise pass — these are the exact collisions that caused the bug, and
# naming them is more honest than hoping a scoring threshold catches them.
NAMESAKE_TRAPS: dict[str, tuple[str, ...]] = {
    "RELIANCE": (
        "reliance steel", "reliance aluminum", "reliance aluminium",
        "reliance global group", "reliance worldwide", "reliance bancshares",
        "nyse: rs", "nyse:rs", "reliance inc",
    ),
    "TITAN": ("titan pharmaceuticals", "titan machinery", "titan international",
              "titan medical", "titan mining"),
    "APOLLOHOSP": ("apollo global management", "apollo endosurgery",
                   "apollo medical holdings", "apollo commercial"),
    "VEDL": ("vedanta resources plc",),
    "SUNPHARMA": ("sun communities", "sun life", "suncor", "sunpower"),
    "TRENT": ("trent university",),
    "IOC": ("international olympic committee",),
    "HEROMOTOCO": ("hero housing finance", "hero fincorp"),
    "BAJFINANCE": ("bajaj auto", "bajaj finserv", "bajaj holdings"),
    "BAJAJFINSV": ("bajaj auto", "bajaj finance limited", "bajaj holdings"),
    "BAJAJ-AUTO": ("bajaj finance", "bajaj finserv"),
    "M&M": ("tech mahindra", "mahindra holidays", "mahindra lifespace"),
    "TECHM": ("mahindra and mahindra limited", "mahindra & mahindra ltd"),
    "HDFCBANK": ("hdfc life", "hdfc amc", "hdfc asset management"),
    "TATASTEEL": ("tata motors", "tata power", "tata consultancy"),
}

_WORD = re.compile(r"[^a-z0-9]+")


def normalize(text: str) -> str:
    """Lowercase, punctuation to spaces, whitespace collapsed."""
    return _WORD.sub(" ", (text or "").lower()).strip()


def distinctive_tokens(company_name: str) -> list[str]:
    """The parts of a company name that actually identify it.

    "Reliance Industries Limited" -> ["reliance", "industries"]
    "Infosys Limited"             -> ["infosys"]
    "State Bank of India"         -> ["state", "bank", "india"]

    Single characters are dropped: they match everything.
    """
    toks = [t for t in normalize(company_name).split()
            if t and t not in LEGAL_SUFFIXES and len(t) > 1]
    # If stripping suffixes left nothing (a company literally named "Group"),
    # fall back to the raw tokens rather than matching every story on earth.
    if not toks:
        toks = [t for t in normalize(company_name).split() if len(t) > 1]
    return toks


def bare_symbol(ticker: str) -> str:
    """RELIANCE.NS -> RELIANCE; ^NSEI -> NSEI; AAPL -> AAPL."""
    return (ticker or "").split(".")[0].lstrip("^").upper()


def entity(ticker: str, company_name: str = "", isin: str = "") -> dict:
    """The identity a headline has to match."""
    bare = bare_symbol(ticker)
    toks = distinctive_tokens(company_name) if company_name else []
    return {
        "ticker": (ticker or "").upper(),
        "symbol": bare,
        "name": company_name or "",
        "isin": (isin or "").upper(),
        "tokens": toks,
        # One common word standing alone needs corroboration.
        "needs_india_context": len(toks) == 1 and toks[0] in AMBIGUOUS_SINGLE_TOKENS,
    }


def _has_exact_symbol(text: str, ent: dict) -> bool:
    """An exchange-qualified reference to this exact listing.

    Bare "RELIANCE" does NOT count — that is the whole bug. It has to be
    qualified by an exchange or a suffix.
    """
    sym = ent["symbol"].lower()
    if not sym:
        return False
    raw = (text or "").lower()
    qualified = (
        f"{sym}.ns", f"{sym}.bo",
        f"nse: {sym}", f"nse:{sym}", f"bse: {sym}", f"bse:{sym}",
        f"nse | {sym}", f"{sym} | nse",
    )
    return any(q in raw for q in qualified)


def match_strength(text: str, ent: dict) -> str:
    """'exact' | 'name' | 'weak' | 'none'.

    exact  an unambiguous identifier — qualified symbol or ISIN
    name   every distinctive token of the company name is present
    weak   only part of the name matched (the Reliance Steel case)
    none   nothing matched
    """
    raw = (text or "").lower()
    if ent["isin"] and ent["isin"].lower() in raw:
        return "exact"
    if _has_exact_symbol(raw, ent):
        return "exact"

    toks = ent["tokens"]
    if not toks:
        return "none"
    norm = normalize(text)
    present = [t for t in toks if re.search(rf"\b{re.escape(t)}\b", norm)]
    if len(present) == len(toks):
        return "name"
    return "weak" if present else "none"


def is_trap(text: str, ent: dict) -> bool:
    """Does this story name a known foreign namesake?"""
    raw = normalize(text)
    for marker in NAMESAKE_TRAPS.get(ent["symbol"], ()):  # noqa: SIM110
        if normalize(marker) in raw:
            return True
    return False


def is_relevant(item: dict, ent: dict) -> bool:
    """Is this headline about this listing?

    Title and summary are searched together — outlets routinely put the
    company's full name in the standfirst and a shortened form in the
    headline, and matching on the headline alone drops real coverage.
    """
    text = f"{item.get('title', '')} {item.get('summary', '')}"
    if is_trap(text, ent):
        return False
    strength = match_strength(text, ent)
    if strength == "exact":
        return True
    if strength != "name":
        return False
    # A one-common-word name needs the story to be about the Indian market.
    if ent["needs_india_context"]:
        return bool(INDIA_MARKERS.search(text.lower()))
    return True


def partition(items: list[dict], ent: dict) -> tuple[list[dict], list[dict]]:
    """(kept, dropped). Callers report the drop count rather than hiding it."""
    kept, dropped = [], []
    for it in items:
        (kept if is_relevant(it, ent) else dropped).append(it)
    return kept, dropped


def search_query(ent: dict) -> str:
    """The news-search string for this entity.

    Quoted full name plus an exchange qualifier. The old query was the bare
    symbol and the word "stock", which is what dragged in every company on
    earth sharing a first word.
    """
    if ent["tokens"]:
        phrase = " ".join(ent["tokens"])
        return f'"{phrase}" (NSE OR India)' if ent["ticker"].endswith(".NS") \
            else f'"{phrase}" stock'
    return f'"{ent["symbol"]}" stock'
