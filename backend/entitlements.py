"""FastAPI dependencies that enforce a plan.

SERVER-SIDE, which is the whole point. Hiding a button is a courtesy to the
user, not a control: the API is public, documented by its own error messages,
and anyone can call it with curl. If the only thing standing between a free
account and the live feed is a disabled button, there is nothing standing
between them.

Three gates, because there are three shapes of limit:

  require(feature)        — a boolean entitlement (the data API, real-time).
  meter(feature, counter) — a per-day allowance that costs money per call.
  ensure_room(...)        — a ceiling on how many of something may exist,
                            called from inside the route because it needs the
                            current count, which only the route can get.

All three produce 402 Payment Required rather than 403 Forbidden. The
distinction matters to the client: 403 means "you may not", which is final and
should show an error; 402 means "not on this plan", which is a different screen
with a price on it. Conflating them means the UI cannot tell a permissions
problem from an upgrade prompt.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status

from backend import auth, plans, usage

# 402 is unusual enough to be worth stating: it is in RFC 9110, it is not
# deprecated, and Stripe/GitHub both use it for exactly this. The alternative
# everyone reaches for, 403, is already used here for "wrong role" and for
# CSRF failures, and a client cannot act on a status that means three things.
_UPGRADE = status.HTTP_402_PAYMENT_REQUIRED


def _plan_name(user: dict) -> str:
    return plans.plan_for(user)


def require(feature: str):
    """Dependency factory: refuse unless the plan grants `feature`."""
    # Validated at import, not per request, so a typo is a startup failure
    # rather than a gate that silently never fires.
    if feature not in plans.ENTITLEMENTS:
        raise KeyError(f"unknown entitlement {feature!r}")

    def gate(user: dict = Depends(auth.current_user)) -> dict:
        if not plans.allows(user, feature):
            raise HTTPException(
                _UPGRADE,
                f"This needs a plan that includes {_label(feature)}. "
                f"You are on {plans.PLANS[_plan_name(user)]['name']}.",
            )
        return user

    return gate


def meter(feature: str, counter: str):
    """Dependency factory: count a use and refuse past the daily allowance.

    Records the use BEFORE the route runs. That direction is deliberate: the
    cost is incurred by calling the provider, so a request that fails upstream
    has still spent our money. Counting only successes would make a failing
    provider a free, unmetered loop.
    """
    if counter not in plans.ENTITLEMENTS:
        raise KeyError(f"unknown entitlement {counter!r}")

    def gate(user: dict = Depends(auth.current_user)) -> dict:
        limit = plans.limit_for(user, counter)
        if limit == plans.UNLIMITED:
            return user
        spent = usage.used(user["username"], feature)
        if spent >= limit:
            raise HTTPException(
                _UPGRADE,
                f"You have used today's {_label(counter)} ({spent}/{limit}). "
                "It resets at midnight IST, or a higher plan lifts the limit.",
            )
        usage.record(user["username"], feature)
        return user

    return gate


def ensure_room(user: dict, feature: str, current_count: int,
                noun: str) -> None:
    """Raise unless one more `noun` fits inside the plan's ceiling.

    Called from inside a route rather than as a dependency because it needs
    the current count, and only the route knows how to get it.

    IMPORTANT: this refuses to CREATE past the ceiling; it never deletes. An
    account whose plan narrows — a lapsed subscription — keeps everything it
    has and simply cannot add more. Deleting a user's watchlists because they
    stopped paying would be indefensible, and silently hiding them is the same
    thing with extra steps.
    """
    if plans.within(user, feature, current_count):
        return
    limit = plans.limit_for(user, feature)
    raise HTTPException(
        _UPGRADE,
        f"You have {current_count} of {limit} {noun} on "
        f"{plans.PLANS[_plan_name(user)]['name']}. Remove one, or move to a "
        "plan with more room.",
    )


def _label(feature: str) -> str:
    """Entitlement keys, in words a user can act on."""
    return {
        "realtime_data": "live prices",
        "data_api": "the spreadsheet API",
        "max_watchlists": "watchlists",
        "max_alerts": "alerts",
        "max_portfolios": "portfolios",
        "max_workspaces": "workspaces",
        "screens_per_day": "screener runs",
        "ai_per_day": "AI requests",
        "history_years": "history",
    }.get(feature, feature)


def assert_allows(user: dict, feature: str) -> None:
    """The imperative form of `require`, for routes that cannot take another
    dependency.

    The data API endpoints authenticate through their own `api_token_user`
    dependency (it accepts a personal API token as well as a browser JWT), so
    stacking a second auth dependency on them would mean two different ideas
    of who the caller is. This checks the user that one already resolved.
    """
    if not plans.allows(user, feature):
        raise HTTPException(
            _UPGRADE,
            f"This needs a plan that includes {_label(feature)}. "
            f"You are on {plans.PLANS[_plan_name(user)]['name']}.",
        )
