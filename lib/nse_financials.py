"""Financial statements for Indian listings, from NSE's own results feed.

Every free statements API covers US listings. FMP's free tier is US-only and
yfinance returns nothing for NSE symbols, so the Financials, Estimates and
Capital-structure screens were empty for exactly the market this terminal is
built around — and three of the screener presets (PEG, Hidden Gems, Growth)
filter on growth and ROCE, so they could never match a single name.

NSE publishes quarterly and annual results itself, at
/api/corporates-financial-results. It is not a statements API: it is the
filing summary a company submits, so it carries the income statement only,
with the line items the exchange asks for. That is enough for growth, margins
and a computed ROCE, and it is the only free source for this market.

Parsing is deliberately defensive. The feed returns numbers as strings, in
lakhs or crores depending on what the company declared, with keys that differ
between the consolidated and standalone filings and occasionally between
companies. Anything unrecognised is dropped rather than guessed at — a wrong
revenue figure is worse than a missing one.
"""
from __future__ import annotations

from datetime import date, datetime

from lib import nse

# ── the field names NSE actually returns ─────────────────────────────────
#
# The feed's keys are terse and inconsistent across filings, so each canonical
# line lists every spelling seen. Order matters: the first key present wins.
_LINES: list[tuple[str, tuple[str, ...]]] = [
    ("Revenue", ("re_net_sal", "income", "re_income", "net_sales", "re_net_sales")),
    ("Other income", ("re_oth_inc", "other_income")),
    ("Total income", ("re_tot_inc", "total_income")),
    ("Total expenditure", ("re_tot_exp", "expenditure", "total_expenditure")),
    ("Operating Income", ("re_op_pro", "operating_profit")),
    ("Interest", ("re_int", "interest")),
    ("Depreciation", ("re_dep", "depreciation")),
    ("Pre-Tax Income", ("re_pro_bfr_tax", "profit_before_tax", "re_pbt")),
    ("Tax Provision", ("re_tax", "tax", "re_provision_tax")),
    ("Net Income", ("re_pro_loss_bef_tax", "re_pro_aft_tax", "profit_after_tax",
                    "re_pat", "net_profit")),
    ("EPS (basic)", ("re_basic_eps_for_cont_dic_optd", "re_basic_eps", "eps")),
    ("EPS (diluted)", ("re_dil_eps_for_cont_dic_optd", "re_diluted_eps")),
]

# NSE reports in lakhs unless the filing says otherwise. Everything else in
# this app is in absolute currency units, so the scale has to be applied here
# or a ₹9.7 lakh crore revenue arrives as 970000.
_UNIT_SCALE = {
    "lakhs": 1e5, "lakh": 1e5, "in lakhs": 1e5,
    "crores": 1e7, "crore": 1e7, "in crores": 1e7,
    "millions": 1e6, "million": 1e6,
    "thousands": 1e3, "thousand": 1e3,
    "actual": 1.0, "units": 1.0, "": 1e5,
}


def _num(v) -> float | None:
    """NSE sends numbers as strings, sometimes with commas or a bare '-'."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if v == v else None          # NaN check
    s = str(v).strip().replace(",", "")
    if not s or s in {"-", "--", "NA", "N.A.", "nan", "None"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _scale_for(row: dict) -> float:
    """Whatever multiplier turns this filing's numbers into currency units."""
    raw = str(row.get("re_unit") or row.get("unit") or "").strip().lower()
    return _UNIT_SCALE.get(raw, _UNIT_SCALE[""])


def _period_end(row: dict) -> str | None:
    """The column label: the period's end date, ISO, so columns sort."""
    for key in ("re_to_date", "to_date", "re_toDate", "period_ended"):
        raw = row.get(key)
        if not raw:
            continue
        s = str(raw).strip()
        for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%b %Y"):
            try:
                return datetime.strptime(s, fmt).date().isoformat()
            except ValueError:
                continue
    return None


def parse_results(rows: list[dict]) -> dict:
    """NSE result filings → {columns: [...], rows: [{line, <col>: value}]}.

    Columns are period-end dates OLDEST FIRST, matching what the statement
    screens expect; the feed returns newest first and mixes consolidated with
    standalone filings for the same quarter.
    """
    if not rows:
        return {"columns": [], "rows": []}

    # One filing per period. Consolidated is the group's real economics, so it
    # wins where a company files both — but a standalone-only period is still
    # better than a gap, so it is kept rather than dropped.
    best: dict[str, dict] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        col = _period_end(r)
        if not col:
            continue
        audited = str(r.get("re_consolidated") or r.get("consolidated") or "").strip().lower()
        consolidated = audited.startswith("c") or audited == "consolidated"
        prev = best.get(col)
        if prev is None or (consolidated and not prev["_consolidated"]):
            best[col] = {"_row": r, "_consolidated": consolidated}

    columns = sorted(best.keys())
    if not columns:
        return {"columns": [], "rows": []}

    out_rows: list[dict] = []
    for line, keys in _LINES:
        cells: dict[str, float | None] = {}
        for col in columns:
            raw = best[col]["_row"]
            val = None
            for k in keys:
                val = _num(raw.get(k))
                if val is not None:
                    break
            # Per-share figures are already per share — scaling them by the
            # filing's lakh/crore unit would produce an EPS in the millions.
            if val is not None and not line.startswith("EPS"):
                val *= _scale_for(raw)
            cells[col] = val
        # A line no filing reported is a line this source doesn't carry.
        if any(v is not None for v in cells.values()):
            out_rows.append({"line": line, **cells})

    return {"columns": columns, "rows": out_rows}


def financial_results(ticker: str, quarterly: bool = True) -> dict:
    """Income-statement history for an Indian listing, from NSE.

    Returns the empty shape rather than raising when NSE is unreachable — the
    caller falls through to its other providers, and a screen that says
    "no data" is better than one that 500s.
    """
    sym = nse._clean_symbol(ticker)
    if not sym:
        return {"columns": [], "rows": []}
    data = nse._get("/api/corporates-financial-results", {
        "index": "equities",
        "symbol": sym,
        "period": "Quarterly" if quarterly else "Annual",
    })
    rows = data if isinstance(data, list) else (data or {}).get("data") or []
    return parse_results(rows if isinstance(rows, list) else [])


# ── shareholding ──────────────────────────────────────────────────────────

def promoter_holding(ticker: str) -> float | None:
    """Promoter stake as a percentage, from NSE's shareholding pattern.

    The screener's Hidden Gems and Growth presets both filter on this and no
    free non-Indian provider carries it, which is a large part of why those
    two screens never returned a row.
    """
    info = nse.corporate_info(ticker)
    if not info:
        return None
    for row in info.get("shareholding_pattern") or []:
        if not isinstance(row, dict):
            continue
        for k, v in row.items():
            key = str(k).lower()
            if "promoter" not in key or "non" in key or "public" in key:
                continue
            # Pledge columns also mention promoters and are a different number.
            if "pledg" in key or "encumb" in key:
                continue
            val = _num(v)
            # A share of the company, so anything outside 0–100 is a different
            # column that happened to mention promoters.
            if val is not None and 0 <= val <= 100:
                return val
    return None


def latest_period(parsed: dict) -> str | None:
    cols = parsed.get("columns") or []
    return cols[-1] if cols else None


def series(parsed: dict, line: str) -> list[float | None]:
    """One line's values across the periods, oldest first."""
    for r in parsed.get("rows") or []:
        if r.get("line") == line:
            return [r.get(c) for c in parsed.get("columns") or []]
    return []


def trailing_twelve(parsed: dict, line: str) -> float | None:
    """Sum of the last four quarters, or None if four aren't available.

    Deliberately refuses a partial sum: three quarters annualised as four is
    a 33% overstatement, and it would look exactly like a real figure.
    """
    vals = [v for v in series(parsed, line) if v is not None]
    if len(vals) < 4:
        return None
    return sum(vals[-4:])


def yoy_growth(parsed: dict, line: str) -> float | None:
    """Latest quarter against the same quarter a year earlier, in percent.

    Year-on-year rather than sequential because Indian results are seasonal —
    a Q3 festive quarter against Q2 measures the calendar, not the business.
    """
    vals = series(parsed, line)
    present = [(i, v) for i, v in enumerate(vals) if v is not None]
    if len(present) < 5:
        return None
    latest_i, latest = present[-1]
    # The comparable quarter is four periods back in the column order.
    target = latest_i - 4
    if target < 0 or vals[target] is None:
        return None
    base = vals[target]
    # A sign flip makes a percentage change meaningless: -10 to +5 is not
    # "150% growth", it is a company that stopped losing money.
    if base == 0 or (base < 0) != (latest < 0):
        return None
    return ((latest - base) / abs(base)) * 100
