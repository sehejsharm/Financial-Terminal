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

The `_LINES` key list below is the exact-spelling guess. It was written from
memory of NSE's field names, not from a live response — this sandbox has no
outbound internet, so it could never be checked against the real feed before
shipping. Two things compensate for that risk rather than pretending it isn't
there: a token-based fuzzy fallback (`_FUZZY`) that still finds the right
column if the exact spelling is wrong, and `probe()`, which returns NSE's raw
row next to what got parsed from it so a wrong mapping is visible and fixable
in minutes once this runs somewhere with real network access (see
`backend/routes/admin.py`'s `/admin/nse-probe/{ticker}`).
"""
from __future__ import annotations

import re
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

# Fallback for when the exact key above is wrong. Each entry is a set of
# WORDS (not substrings) that must all appear, in any order, among a key's
# underscore-separated tokens — e.g. {"net", "profit"} matches
# "re_net_profit_incl_oci" but not "re_net_worth". Tried only for a column
# where no exact key matched, and only against keys not already claimed by
# another line in the same row, so two canonical lines can't collapse onto
# one NSE field.
_FUZZY: dict[str, tuple[frozenset[str], ...]] = {
    "Revenue": (frozenset({"net", "sale"}), frozenset({"revenue"}),
                frozenset({"total", "revenue"}), frozenset({"net", "sales"})),
    "Other income": (frozenset({"other", "income"}),),
    "Total income": (frozenset({"total", "income"}),),
    "Total expenditure": (frozenset({"total", "expenditure"}),
                          frozenset({"total", "expense"})),
    "Operating Income": (frozenset({"operating", "profit"}),
                        frozenset({"op", "profit"})),
    "Interest": (frozenset({"finance", "cost"}), frozenset({"interest"})),
    "Depreciation": (frozenset({"depreciation"}), frozenset({"dep", "amort"})),
    "Pre-Tax Income": (frozenset({"profit", "before", "tax"}),
                       frozenset({"pbt"})),
    "Tax Provision": (frozenset({"tax", "expense"}),
                      frozenset({"provision", "tax"}), frozenset({"total", "tax"})),
    "Net Income": (frozenset({"profit", "after", "tax"}),
                  frozenset({"net", "profit"}), frozenset({"pat"}),
                  frozenset({"profit", "period"})),
    "EPS (basic)": (frozenset({"basic", "eps"}),),
    "EPS (diluted)": (frozenset({"diluted", "eps"}),),
}


def _tokens(key: str) -> set[str]:
    return set(re.split(r"[^a-z0-9]+", str(key).lower())) - {""}


def _fuzzy_match(raw: dict, line: str, exclude: set[str]) -> str | None:
    """The first unclaimed key in `raw` whose tokens satisfy one of `line`'s
    fuzzy word-sets. Deterministic: keys are tried in sorted order."""
    wordsets = _FUZZY.get(line)
    if not wordsets:
        return None
    for key in sorted(raw.keys()):
        if key in exclude or not isinstance(key, str):
            continue
        toks = _tokens(key)
        if any(ws <= toks for ws in wordsets):
            return key
    return None

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


def _extract_row(raw: dict) -> dict[str, tuple[str | None, float | None]]:
    """One filing row → {line: (key_used, scaled_value)} for every canonical
    line, trying the exact spellings first and the fuzzy word-match second.

    Claiming is per-row: once a key has supplied a value for one line it is
    removed from consideration for the rest of that same row, so a guessed
    fuzzy match can't collapse two different lines onto one NSE field.
    """
    claimed: set[str] = set()
    out: dict[str, tuple[str | None, float | None]] = {}
    for line, keys in _LINES:
        key_used: str | None = None
        val: float | None = None
        for k in keys:
            if k in claimed:
                continue
            val = _num(raw.get(k))
            if val is not None:
                key_used = k
                break
        if val is None:
            fuzzy_key = _fuzzy_match(raw, line, claimed)
            if fuzzy_key is not None:
                val = _num(raw.get(fuzzy_key))
                if val is not None:
                    key_used = fuzzy_key
        if key_used is not None:
            claimed.add(key_used)
        if val is not None and not line.startswith("EPS"):
            val *= _scale_for(raw)
        out[line] = (key_used, val)
    return out


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

    extracted = {col: _extract_row(best[col]["_row"]) for col in columns}

    out_rows: list[dict] = []
    for line, _keys in _LINES:
        cells: dict[str, float | None] = {col: extracted[col][line][1] for col in columns}
        # A line no filing reported is a line this source doesn't carry.
        if any(v is not None for v in cells.values()):
            out_rows.append({"line": line, **cells})

    return {"columns": columns, "rows": out_rows}


def probe(ticker: str, quarterly: bool = True) -> dict:
    """Diagnostic: NSE's raw filing next to what got parsed from it, plus
    which NSE key (if any) supplied each canonical line and whether it came
    from the exact spelling list or the fuzzy fallback.

    This exists because `_LINES` was written from memory of NSE's field
    names, never checked against a live response — this sandbox has no
    outbound internet. Meant to be hit from somewhere that DOES have real
    NSE access (the production backend) so a wrong mapping is visible and
    fixable, instead of silently returning nothing forever.
    """
    sym = nse._clean_symbol(ticker)
    if not sym:
        return {"ticker": ticker, "ok": False, "reason": "not a recognised ticker"}
    data = nse._get("/api/corporates-financial-results", {
        "index": "equities",
        "symbol": sym,
        "period": "Quarterly" if quarterly else "Annual",
    })
    if data is None:
        return {"ticker": ticker, "ok": False,
                "reason": "NSE returned nothing — session warm-up or rate limiting"}
    rows = data if isinstance(data, list) else (data or {}).get("data") or []
    rows = [r for r in rows if isinstance(r, dict)]
    if not rows:
        return {"ticker": ticker, "ok": False,
                "reason": "response had no filing rows", "raw_sample": data}

    parsed = parse_results(rows)
    latest_raw = rows[0]
    extraction = _extract_row(latest_raw)
    mapping = []
    for line, keys in _LINES:
        key_used, val = extraction[line]
        mapping.append({
            "line": line,
            "matched_key": key_used,
            "matched_via": "exact" if key_used in keys else
                          ("fuzzy" if key_used else None),
            "value": val,
        })
    return {
        "ticker": ticker,
        "ok": True,
        "raw_keys": sorted(latest_raw.keys()),
        "raw_sample_row": latest_raw,
        "mapping": mapping,
        "unmapped_lines": [m["line"] for m in mapping if m["matched_key"] is None],
        "parsed": parsed,
    }


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
