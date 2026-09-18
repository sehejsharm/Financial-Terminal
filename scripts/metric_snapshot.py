#!/usr/bin/env python3
"""Render every metric for the golden universe to a flat JSON snapshot (Phase 0.3).

WHY THIS EXISTS
---------------
The failure mode this run is most exposed to is fixing a number into a
*different wrong number*. A test proves a rule holds; it does not tell you that
Reliance's P/E moved from 22.46 to 24.10 and that you now have to justify which
one is right. This harness makes every numeric change visible as a diff, so a
reviewer can spot-check against a primary source instead of trusting that green
tests mean correct values.

USAGE

    python scripts/metric_snapshot.py --out before.json
    ...make changes...
    python scripts/metric_snapshot.py --out after.json
    python scripts/metric_snapshot.py --diff before.json after.json

The diff output is what goes in the PR description.

HONESTY ABOUT COVERAGE
----------------------
Metrics are computed from captured fixtures. Where a fixture has not been
captured (this repo is developed with no route to the providers), the entry is
recorded as `"_status": "not_captured"` rather than omitted — a metric silently
missing from both snapshots would diff as "no change" and look like safety.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "golden"
RAW = GOLDEN / "raw"
sys.path.insert(0, str(ROOT))

# Metrics worth diffing. Anything a user reads off a screen and might act on.
TRACKED = [
    "price", "mcap_cr", "pe", "forward_pe", "peg", "pb", "ps",
    "eps_growth", "sales_growth", "roce", "roe",
    "profit_margin", "operating_margin", "gross_margin",
    "de", "current_ratio", "revenue_cr", "fcf_cr",
    "div_yield", "beta", "promoter", "change_pct", "pos_52w",
]


def load_universe() -> list[dict]:
    return json.loads((GOLDEN / "universe.json").read_text())["tickers"]


def load_raw(probe: str, symbol: str):
    path = RAW / probe / f"{symbol.replace('^', '_idx_')}.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict) and "_error" in payload:
        return None
    return payload


def fundamentals_for(symbol: str) -> dict | None:
    """Assemble the `f` dict _build_metrics expects, from captured fixtures.

    Deliberately thin — it maps captured provider keys onto the shape the
    existing code already consumes. It must NOT normalise units or currency:
    the point of the snapshot is to show what the shipping code produces from
    real provider output, including the defects.
    """
    info = load_raw("yfinance_info", symbol)
    if not info:
        return None
    return {
        "name": info.get("longName") or info.get("shortName") or symbol,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "market_cap": info.get("marketCap"),
        "price": info.get("currentPrice") or info.get("regularMarketPrice"),
        "trailing_pe": info.get("trailingPE"),
        "forward_pe": info.get("forwardPE"),
        "price_to_book": info.get("priceToBook"),
        "price_to_sales": info.get("priceToSalesTrailing12Months"),
        "revenue": info.get("totalRevenue"),
        "free_cashflow": info.get("freeCashflow"),
        "dividend_yield": info.get("dividendYield"),
        "beta": info.get("beta"),
        "roe": info.get("returnOnEquity"),
        "profit_margin": info.get("profitMargins"),
        "operating_margin": info.get("operatingMargins"),
        "gross_margin": info.get("grossMargins"),
        "current_ratio": info.get("currentRatio"),
        "debt_to_equity": info.get("debtToEquity"),
        "earnings_growth": info.get("earningsGrowth"),
        "revenue_growth": info.get("revenueGrowth"),
        "held_insiders": info.get("heldPercentInsiders"),
        "fifty_two_week_high": info.get("fiftyTwoWeekHigh"),
        "fifty_two_week_low": info.get("fiftyTwoWeekLow"),
        "currency": info.get("currency"),
        "financial_currency": info.get("financialCurrency"),
    }


def snapshot() -> dict:
    from lib.screens import _build_metrics

    out: dict = {"_tracked": TRACKED, "tickers": {}}
    captured = missing = 0
    for entry in load_universe():
        symbol = entry["symbol"]
        f = fundamentals_for(symbol)
        if f is None:
            out["tickers"][symbol] = {"_status": "not_captured"}
            missing += 1
            continue
        try:
            m = _build_metrics(symbol, f) or {}
        except Exception as exc:                            # noqa: BLE001
            out["tickers"][symbol] = {"_status": f"error: {type(exc).__name__}: {exc}"}
            missing += 1
            continue
        out["tickers"][symbol] = {"_status": "ok",
                                  **{k: m.get(k) for k in TRACKED}}
        captured += 1
    out["_summary"] = {"captured": captured, "not_captured": missing}
    return out


def diff(a_path: Path, b_path: Path) -> int:
    a = json.loads(a_path.read_text())["tickers"]
    b = json.loads(b_path.read_text())["tickers"]
    changes = 0
    for symbol in sorted(set(a) | set(b)):
        ra, rb = a.get(symbol, {}), b.get(symbol, {})
        keys = (set(ra) | set(rb)) - {"_status"}
        rows = []
        if ra.get("_status") != rb.get("_status"):
            rows.append(("_status", ra.get("_status"), rb.get("_status")))
        for k in sorted(keys):
            va, vb = ra.get(k), rb.get(k)
            if va != vb:
                rows.append((k, va, vb))
        if rows:
            changes += len(rows)
            print(f"\n{symbol}")
            for k, va, vb in rows:
                print(f"  {k:18} {str(va):>16}  ->  {str(vb)}")
    print(f"\n{changes} metric value(s) changed across "
          f"{len(set(a) | set(b))} tickers")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="write a snapshot to this path")
    ap.add_argument("--diff", nargs=2, metavar=("BEFORE", "AFTER"))
    args = ap.parse_args()

    if args.diff:
        return diff(Path(args.diff[0]), Path(args.diff[1]))

    snap = snapshot()
    text = json.dumps(snap, indent=2, sort_keys=True, default=str)
    if args.out:
        Path(args.out).write_text(text)
        print(f"wrote {args.out}: {snap['_summary']}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
