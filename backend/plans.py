"""Plans and what each one entitles an account to.

One table, in one file, because the alternative is what this replaces: limits
scattered as module constants across six routers (_MAX_ALERTS in alerts.py,
_MAX_PORTFOLIOS in portfolio.py, and so on), where nobody can answer "what
does the free tier actually get?" without reading the whole backend.

THE SHAPE OF THE PRICING, stated plainly because it is a product decision and
not an implementation detail:

The thing worth paying for is REAL-TIME DATA. Delayed quotes are genuinely
useful — for research, screening, reading a balance sheet, running a backtest —
and a free tier that cannot do those is not a free tier, it is a demo. So the
free limits here are set to what a real person doing real research needs, and
the paid tier sells the live feed, the spreadsheet API, and headroom.

What this deliberately does NOT do is cripple the free tier to manufacture
urgency. No countdown, no artificial scarcity, no shrinking of something that
already worked. The two metered limits that exist (screens and AI calls) are
there because each of those requests costs us money per call at a provider, so
an unmetered free tier is a bill, not a growth strategy.

GRANDFATHERING: accounts that existed before plans did are migrated to `pro`,
not `free`. See `backfill_plans`. Defaulting them to free would silently cut a
working account from 40 alerts to 10 — a limit nobody agreed to, applied
retroactively.
"""
from __future__ import annotations

from typing import Any

FREE = "free"
PRO = "pro"

# Every entitlement key, so a typo in a gate is a KeyError at import rather
# than a silently-permissive check. `limit_for` and `allows` both validate
# against this.
ENTITLEMENTS = (
    "realtime_data",      # live feed vs delayed quotes — the paid lever
    "data_api",           # /data/bdp + /bdh, i.e. Excel and Sheets
    "max_watchlists",
    "max_alerts",
    "max_portfolios",
    "max_workspaces",
    "screens_per_day",    # each run is a ~70-name scan at a paid provider
    "ai_per_day",         # each call costs LLM tokens
    "history_years",      # how far back history and backtests can reach
)

# -1 means no limit. Chosen over None or a sentinel string because it compares
# correctly in the one place it matters: `used >= limit` is False for -1
# without a special case at every call site.
UNLIMITED = -1

PLANS: dict[str, dict[str, Any]] = {
    FREE: {
        "name": "Free",
        "price_inr_month": 0,
        "blurb": "Delayed prices, full fundamentals, and the research tools.",
        "entitlements": {
            # Delayed, not absent. The screeners, fundamentals, quant and
            # portfolio pages all work on this.
            "realtime_data": False,
            "data_api": False,
            "max_watchlists": 3,
            "max_alerts": 10,
            "max_portfolios": 2,
            "max_workspaces": 3,
            "screens_per_day": 10,
            "ai_per_day": 10,
            "history_years": 5,
        },
    },
    PRO: {
        "name": "Pro",
        "price_inr_month": 499,
        "blurb": "Live prices, the spreadsheet API, and room to work.",
        "entitlements": {
            "realtime_data": True,
            "data_api": True,
            "max_watchlists": 25,
            "max_alerts": 100,
            "max_portfolios": 20,
            "max_workspaces": 25,
            "screens_per_day": 200,
            "ai_per_day": 200,
            "history_years": UNLIMITED,
        },
    },
}

DEFAULT_PLAN = FREE

# The master admin is not on a plan. They operate the product; metering the
# person who has to reproduce a user's bug report is pointless, and locking
# them out of a feature they need to support is worse.
_ADMIN_ROLE = "master_admin"


def known(plan: str) -> bool:
    return plan in PLANS


def plan_for(user: dict | None) -> str:
    """The plan name for a user dict, falling back to the default.

    An unknown stored value resolves to the default rather than raising: a
    typo in the user table, or a plan removed from the catalogue, must not
    take someone's account down — it should quietly give them the free tier
    and show up as a support question.
    """
    if not user:
        return DEFAULT_PLAN
    name = (user.get("plan") or "").strip().lower()
    return name if known(name) else DEFAULT_PLAN


def entitlements(user: dict | None) -> dict[str, Any]:
    """Everything this user is entitled to, admin override included."""
    if user and user.get("role") == _ADMIN_ROLE:
        return _admin_entitlements()
    return dict(PLANS[plan_for(user)]["entitlements"])


def _admin_entitlements() -> dict[str, Any]:
    """Everything on, every ceiling removed."""
    out: dict[str, Any] = {}
    for key in ENTITLEMENTS:
        sample = PLANS[PRO]["entitlements"][key]
        out[key] = True if isinstance(sample, bool) else UNLIMITED
    return out


def allows(user: dict | None, feature: str) -> bool:
    """Whether a boolean entitlement is granted."""
    if feature not in ENTITLEMENTS:
        raise KeyError(f"unknown entitlement {feature!r}")
    value = entitlements(user).get(feature)
    if isinstance(value, bool):
        return value
    # A numeric entitlement asked as a boolean: treat any allowance as yes.
    return value == UNLIMITED or (isinstance(value, int) and value > 0)


def limit_for(user: dict | None, feature: str) -> int:
    """A numeric ceiling. UNLIMITED (-1) means no ceiling."""
    if feature not in ENTITLEMENTS:
        raise KeyError(f"unknown entitlement {feature!r}")
    value = entitlements(user).get(feature)
    if isinstance(value, bool):
        raise TypeError(f"{feature} is a boolean entitlement, use allows()")
    return int(value)


def within(user: dict | None, feature: str, current_count: int) -> bool:
    """Whether one more of something is allowed."""
    limit = limit_for(user, feature)
    return limit == UNLIMITED or current_count < limit


def catalogue() -> list[dict]:
    """The plans, for the pricing UI. Ordered cheapest first."""
    return [
        {"id": pid, "name": p["name"],
         "price_inr_month": p["price_inr_month"],
         "blurb": p["blurb"],
         "entitlements": dict(p["entitlements"])}
        for pid, p in sorted(PLANS.items(),
                             key=lambda kv: kv[1]["price_inr_month"])
    ]
