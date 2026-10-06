"""What plan am I on, what does it include, and what have I used.

No payment vendor is wired up here. Checkout is deliberately absent rather
than stubbed: a `/checkout` endpoint that 501s is a thing the front end will
be built against and then have to be rebuilt, and the shape of it depends on
whether the provider is Razorpay (orders + a client-side handler) or Stripe
(a redirect to a hosted page). Those are different enough that guessing is
worse than waiting.

Until a provider is chosen, plans are set by an admin — see
POST /admin/users/{username}/plan. That is a real path, not a placeholder: it
is how the first paying users will be onboarded anyway, and how support will
fix a failed webhook for as long as this product exists.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from backend import auth, plans, usage
from lib import auth as user_store

router = APIRouter(prefix="/billing", tags=["billing"])

# Which metered counter backs which entitlement. One place, so the account
# screen and the gates cannot disagree about what "used" means.
METERED = {
    "screens_per_day": "screens",
    "ai_per_day": "ai",
}


@router.get("/plans")
def list_plans():
    """The catalogue, for a pricing table. Needs no authentication — a price
    list people cannot read before signing up is not a price list."""
    return {"plans": plans.catalogue()}


@router.get("/plan")
def my_plan(user: dict = Depends(auth.current_user)):
    """The caller's plan, entitlements, and today's usage.

    Reads the plan from the USER TABLE rather than the token, so an upgrade
    shows up here immediately instead of after the access token rolls over.
    The gates use the token, which is why the client refreshes after a change.
    """
    live = user_store.get_user(user["username"]) or user
    name = plans.plan_for(live)
    ents = plans.entitlements(live)
    spent = usage.snapshot(user["username"])

    return {
        "plan": name,
        "plan_name": plans.PLANS[name]["name"],
        "price_inr_month": plans.PLANS[name]["price_inr_month"],
        # True when the caller is the operator rather than a subscriber, so
        # the UI can say so instead of claiming they are on a plan they are
        # not paying for.
        "admin_override": live.get("role") == "master_admin",
        "entitlements": ents,
        "usage": {
            feature: {"used": spent.get(counter, 0),
                      "limit": ents[feature]}
            for feature, counter in METERED.items()
        },
        "unlimited": plans.UNLIMITED,
    }
