"""JSON-safe serialisation helpers for pandas frames / mixed values.

yfinance hands back DataFrames full of numpy scalars, NaN, and Timestamps —
none of which FastAPI can encode reliably. These helpers coerce to plain
JSON types so route handlers can return frames without surprises.
"""
from __future__ import annotations

import json
import math
from typing import Any

import pandas as pd
from starlette.responses import JSONResponse


def clean(v: Any) -> Any:
    """Coerce a single value to something JSON-serialisable (or None)."""
    if v is None:
        return None
    if hasattr(v, "isoformat"):          # datetime / Timestamp
        try:
            return v.isoformat()
        except Exception:
            return str(v)
    if hasattr(v, "item"):               # numpy scalar
        try:
            v = v.item()
        except Exception:
            pass
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (int, float, str, bool)):
        return v
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return str(v)


def clean_dict(d: dict | None) -> dict:
    if not isinstance(d, dict):
        return {}
    return {str(k): clean(v) for k, v in d.items()}


def records(df: pd.DataFrame | None) -> list[dict]:
    """List-of-dicts with NO synthetic index column. For clean-keyed frames."""
    if df is None or not hasattr(df, "empty") or df.empty:
        return []
    return [{str(c): clean(v) for c, v in row.items()} for _, row in df.iterrows()]


def frame_payload(df: pd.DataFrame | None) -> dict:
    """{columns, rows} including the index as its own column. For labelled frames."""
    if df is None or not hasattr(df, "empty") or df.empty:
        return {"columns": [], "rows": []}
    df = df.reset_index()
    cols = [str(c) for c in df.columns]
    rows = [{str(c): clean(v) for c, v in row.items()} for _, row in df.iterrows()]
    return {"columns": cols, "rows": rows}


# ── the response class that makes NaN impossible to emit ──────────────────
#
# A provider gap used to become an HTTP 500. Starlette's JSONResponse renders
# with json.dumps(..., allow_nan=False), so a single NaN anywhere in a payload
# raises ValueError and the request dies:
#
#     ValueError: Out of range float values are not JSON compliant: nan
#
# The helpers above (clean/clean_dict/records/frame_payload) already fix this —
# but they have to be CALLED, and they were applied in four routers out of
# nine. deals, fundamentals, macro and options had them; screens, market,
# portfolio, value_chain and ai did not. portfolio is the one that mattered
# most: it computes weights and P&L, which is exactly where a missing price or
# a zero denominator produces NaN, and it is a core daily surface.
#
# WHY CENTRAL RATHER THAN NINE MORE CALL SITES. Adding the call to the five
# stragglers fixes today and not next year: the tenth router someone adds will
# be wrong in the same way, and nothing will tell them. Installed as the app's
# default_response_class, a route CANNOT emit NaN whether or not its author
# thought about it.
#
# WHY IT DOES NOT CHANGE A WORKING RESPONSE. The sanitising pass only ever runs
# on a payload that would otherwise have raised — that is, on a response that
# did not exist, because the request 500'd. Anything that serialises today
# serialises byte-identically.
#
# WHY TRY-THEN-FIX RATHER THAN ALWAYS-WALK. Deep-walking every response to look
# for a NaN would cost on every request to pay for a rare one. Letting the
# strict encoder try first is free on the happy path and only pays the walk
# when the alternative was a 500.

def deep_clean(value: Any) -> Any:
    """Recursively coerce a payload to something json.dumps(allow_nan=False)
    will accept. Containers are rebuilt rather than mutated, because the caller
    may still hold a reference to the original."""
    if isinstance(value, dict):
        return {k: deep_clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [deep_clean(v) for v in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        # None, not 0.0: a missing or undefined figure is not zero, and
        # rendering it as zero is how a blank cell becomes a confident claim.
        return None
    return value


class SafeJSONResponse(JSONResponse):
    """JSONResponse that degrades a NaN to null instead of raising a 500.

    Installed as the app's default_response_class — see backend/app.py.
    """

    def render(self, content: Any) -> bytes:
        try:
            return super().render(content)
        except ValueError:
            # The only ValueError json.dumps raises here is the out-of-range
            # float one; allow_nan=False is what produces it. Re-rendering the
            # cleaned payload rather than returning a canned error means the
            # user gets their data with a null in the one field that was
            # undefined, which is what they actually wanted.
            return super().render(deep_clean(content))
