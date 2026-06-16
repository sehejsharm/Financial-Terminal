"""JSON-safe serialisation helpers for pandas frames / mixed values.

yfinance hands back DataFrames full of numpy scalars, NaN, and Timestamps —
none of which FastAPI can encode reliably. These helpers coerce to plain
JSON types so route handlers can return frames without surprises.
"""
from __future__ import annotations

import math
from typing import Any

import pandas as pd


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
