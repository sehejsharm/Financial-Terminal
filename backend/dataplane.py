"""Which data plane a request is served from, and what we may say about it.

THE LICENSING PROBLEM THIS EXISTS FOR

A real-time market-data licence says who may see the prices. If a licensed feed
is wired up and a free account receives a tick from it, that is a breach of
contract, not a missing feature — and it is the kind of breach that is found in
an audit of logs months later. So the split cannot be a UI decision or a
courtesy; it has to be impossible for a licensed tick to reach an unlicensed
subscriber.

THE DELAY IS A PROPERTY OF THE SOURCE, NOT OF THE TIER

This is the part worth reading twice, because the obvious design is wrong.

Today every price in this app comes from a PUBLIC source: NSE's own website,
Twelve Data, yfinance. None of it is licensed real-time data, and none of it
comes with a contract saying who may look at it. Applying a fifteen-minute
delay to free users today would therefore make the product worse for no
licensing reason at all — and it would mean printing "delayed by 15 minutes" on
a number whose actual lag we do not know, which is a false claim to put on a
finance screen.

So `requires_delay` asks about the SOURCE first. A public tick is passed
straight through to everyone, labelled honestly as public and carrying the
as-of timestamp the provider gave us. A LICENSED tick is held back for free
accounts and passed live to paid ones. The consequence is the useful one:
nothing changes for anybody today, and on the day a feed is signed, the split
starts working without a single call site being revisited.

WHAT WE SAY ABOUT IT

Every quote carries `tier`, `source_class` and `as_of`. We never claim a
delay we have not applied, and never claim real-time for data we did not get
from a real-time feed. "Delayed" with no number is better than a number we
invented.
"""
from __future__ import annotations

import os
import time
from typing import Any

from backend import plans

# ── tiers (what the CALLER is entitled to) ────────────────────────────────
REALTIME = "realtime"
DELAYED = "delayed"

# ── source classes (what the DATA is) ─────────────────────────────────────
# Unlicensed public endpoints. No contract governs who may see it, so there is
# nobody to protect it from — and no basis for claiming a specific lag.
PUBLIC = "public"
# A paid real-time feed under contract. Entitlement-restricted by that
# contract, which is what the delay enforces.
LICENSED = "licensed"

# How far behind a free account sees licensed data. Fifteen minutes is the
# conventional exchange figure for "delayed" quotes and is what NSE's own
# delayed products use; the real number is whatever the signed contract says,
# so it is configurable rather than hardcoded into the logic.
DELAY_SECONDS = int(os.getenv("DELAYED_FEED_SECONDS") or 15 * 60)


def tier_for(user: dict | None) -> str:
    """The plane this caller is entitled to."""
    return REALTIME if plans.allows(user, "realtime_data") else DELAYED


def requires_delay(source_class: str, tier: str) -> bool:
    """Whether data from `source_class` must be held back from `tier`.

    Reads source first, deliberately — see the module docstring. A public tick
    is not withheld from anybody, because there is no licence to honour and
    pretending otherwise would be a worse product for no gain.
    """
    return source_class == LICENSED and tier != REALTIME


def annotate(quote: dict[str, Any], *, tier: str, source_class: str,
             as_of: float | None = None) -> dict[str, Any]:
    """Stamp a quote with where it came from and how current it is.

    `as_of` is epoch seconds and should be the provider's own timestamp where
    there is one. Falling back to "now" is a last resort and is marked as such
    by `as_of_estimated`, because a chart that says 15:29:58 when the figure
    is actually from 15:14 is worse than one that admits it does not know.
    """
    estimated = as_of is None
    stamp = as_of if as_of is not None else time.time()
    out = dict(quote)
    out["tier"] = tier
    out["source_class"] = source_class
    out["as_of"] = stamp
    out["as_of_estimated"] = estimated
    # Only stated when a delay was actually applied. An absent field means
    # "not delayed by us", which is different from "delayed by zero".
    if requires_delay(source_class, tier):
        out["delayed_by_seconds"] = DELAY_SECONDS
    return out


def label(source_class: str, tier: str) -> str:
    """One short phrase for the UI. No invented numbers."""
    if requires_delay(source_class, tier):
        minutes = max(1, DELAY_SECONDS // 60)
        return f"Delayed {minutes} min"
    if source_class == LICENSED:
        return "Live"
    # Public data. We do not know its lag and will not guess one: NSE's site
    # and Twelve Data both vary, and "Real-time" here would be a claim we
    # cannot stand behind.
    return "Public data"
