"""Value-investing frameworks: Graham intrinsic value and a Buffett checklist.

Educational heuristics built from available fundamentals. Not advice, not a
recommendation, and dependent on the quality of the underlying data.
"""
from __future__ import annotations


def graham_intrinsic_value(eps: float, growth_pct: float, bond_yield_pct: float,
                           base_yield: float = 4.4) -> float | None:
    """Graham's revised formula: V = EPS x (8.5 + 2g) x base_yield / Y.

    eps trailing EPS, growth_pct expected annual growth (%), bond_yield_pct the
    current high-grade bond yield (%), base_yield the yield Graham normalized to.
    """
    if eps is None or eps <= 0 or not bond_yield_pct:
        return None
    g = max(min(growth_pct or 0.0, 30.0), 0.0)  # clamp to keep it conservative
    return eps * (8.5 + 2 * g) * base_yield / bond_yield_pct


def margin_of_safety(intrinsic: float | None, price: float | None) -> float | None:
    if not intrinsic or not price:
        return None
    return (intrinsic - price) / intrinsic * 100.0


def _status(value, pass_test, warn_test) -> str:
    if value is None:
        return "na"
    if pass_test(value):
        return "pass"
    if warn_test(value):
        return "warn"
    return "fail"


def buffett_checklist(f: dict, intrinsic: float | None = None,
                      price: float | None = None) -> tuple[list[dict], dict]:
    """Return (items, summary) scoring Buffett-style tenets.

    Each item: {category, criterion, status in pass/warn/fail/na, detail}.
    """
    items: list[dict] = []

    def add(cat, crit, status, detail):
        items.append({"category": cat, "criterion": crit,
                      "status": status, "detail": detail})

    pm = (f.get("profit_margin") or 0) * 100 if f.get("profit_margin") is not None else None
    om = (f.get("operating_margin") or 0) * 100 if f.get("operating_margin") is not None else None
    roe = (f.get("roe") or 0) * 100 if f.get("roe") is not None else None
    roa = (f.get("roa") or 0) * 100 if f.get("roa") is not None else None
    de = f.get("debt_to_equity")  # percentage form (50 == 0.5x)
    pe = f.get("trailing_pe")
    peg = f.get("peg")
    fcf = f.get("free_cashflow")
    rev_g = (f.get("revenue_growth") or 0) * 100 if f.get("revenue_growth") is not None else None

    # Business
    add("Business", "Consistently profitable (net margin)",
        _status(pm, lambda v: v >= 10, lambda v: v >= 3),
        f"Net margin {pm:.1f}%" if pm is not None else "n/a")
    add("Business", "Revenue growing",
        _status(rev_g, lambda v: v >= 8, lambda v: v >= 0),
        f"Revenue growth {rev_g:+.1f}%" if rev_g is not None else "n/a")

    # Management
    add("Management", "High return on equity",
        _status(roe, lambda v: v >= 15, lambda v: v >= 10),
        f"ROE {roe:.1f}%" if roe is not None else "n/a")
    add("Management", "Conservative leverage (D/E)",
        _status(de, lambda v: v < 50, lambda v: v < 100),
        f"D/E {de:.0f} (~{de/100:.2f}x)" if de is not None else "n/a")

    # Financial
    add("Financial", "Strong operating margin",
        _status(om, lambda v: v >= 15, lambda v: v >= 8),
        f"Operating margin {om:.1f}%" if om is not None else "n/a")
    add("Financial", "Efficient assets (ROA)",
        _status(roa, lambda v: v >= 8, lambda v: v >= 4),
        f"ROA {roa:.1f}%" if roa is not None else "n/a")
    add("Financial", "Positive free cash flow",
        "pass" if (fcf or 0) > 0 else ("na" if fcf is None else "fail"),
        "Free cash flow positive" if (fcf or 0) > 0 else "Negative/unknown FCF")

    # Value
    add("Value", "Reasonable P/E",
        _status(pe, lambda v: 0 < v < 20, lambda v: 0 < v < 30),
        f"P/E {pe:.1f}" if pe else "n/a")
    add("Value", "Growth-adjusted value (PEG)",
        _status(peg, lambda v: 0 < v < 1, lambda v: 0 < v < 2),
        f"PEG {peg:.2f}" if peg else "n/a")
    mos = margin_of_safety(intrinsic, price)
    add("Value", "Margin of safety vs intrinsic",
        _status(mos, lambda v: v >= 20, lambda v: v >= 0),
        f"Margin of safety {mos:+.1f}%" if mos is not None else "n/a")

    passes = sum(1 for i in items if i["status"] == "pass")
    warns = sum(1 for i in items if i["status"] == "warn")
    fails = sum(1 for i in items if i["status"] == "fail")
    scored = passes + warns + fails
    score = round(passes / scored * 100) if scored else 0
    return items, {"pass": passes, "warn": warns, "fail": fails,
                   "score": score, "scored": scored}
