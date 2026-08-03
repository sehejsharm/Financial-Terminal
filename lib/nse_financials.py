"""Financial statements for Indian listings, from NSE's own results filings.

Every free statements API covers US listings. FMP's free tier is US-only and
yfinance returns nothing for NSE symbols, so the Financials, Estimates and
Capital-structure screens were empty for exactly the market this terminal is
built around — and three of the screener presets (PEG, Hidden Gems, Growth)
filter on growth and ROCE, so they could never match a single name.

WHERE THE NUMBERS ACTUALLY ARE. The first version of this module read
/api/corporates-financial-results and looked for line items in it. A probe run
against RELIANCE.NS from the production backend returned these keys and
nothing else:

    audited, bank, broadCastDate, companyName, consolidated, cumulative,
    difference, exchdisstime, filingDate, financialYear, format, fromDate,
    indAs, industry, isin, oldNewFlag, params, period, reInd, relatingTo,
    resultDescription, resultDetailedDataLink, seqNumber, symbol, toDate, xbrl

That endpoint is an ANNOUNCEMENT INDEX. It says a filing exists and where to
find it; it has never carried a revenue figure. All twelve line items came
back unmapped because there was nothing there to map — no amount of alias
tuning could have fixed it.

The numbers are in the XBRL document each row links to, under `xbrl` (or
`resultDetailedDataLink` when NSE populates it). This module fetches that
document and parses it via `lib.nse_xbrl`.

WHAT THAT CHANGES ABOUT UNITS. The old code multiplied by a lakh/crore factor
read from the filing. XBRL instance documents state actual values in the unit
named by `unitRef`, so there is nothing to multiply — and `decimals="-7"` is a
precision statement ("accurate to the nearest crore"), not a scale. Applying
it as one would be a 10-million-fold error, so it is recorded and ignored.

HOW A WRONG MAPPING SHOWS UP NOW. Guessed tag names could still be wrong, so
`probe()` reports the filing's own internal identities — revenue plus other
income against total income, income less expenditure against pre-tax profit,
net income over EPS against the share count. Those have to hold in any real
filing whatever the tags are called, which makes a mismapping visible without
anyone needing to know the company's true numbers in advance.
"""
from __future__ import annotations

import re
import threading
import time
from datetime import date

from lib import nse, nse_xbrl

# ── canonical lines -> the XBRL element names that carry them ────────────
#
# Ind-AS results taxonomy. Element names are matched on their LOCAL name, so
# the namespace prefix (in-capmkt:, in-bse-fin:, ind-as:) is irrelevant.
# Order within a tuple is preference order; order of the list itself matters
# because an earlier line claims a tag before a later one can.
_LINES: list[tuple[str, tuple[str, ...]]] = [
    ("Revenue", (
        "RevenueFromOperations", "Revenue", "RevenueFromOperationsNet",
        "IncomeFromOperations", "NetSales", "NetSalesOrIncomeFromOperations",
    )),
    ("Other income", ("OtherIncome", "OtherIncomeTotal")),
    ("Total income", ("Income", "TotalIncome", "TotalRevenue")),
    ("Total expenditure", (
        "Expenses", "TotalExpenses", "TotalExpenditure", "ExpensesTotal",
    )),
    ("Operating Income", (
        "ProfitBeforeInterestDepreciationAndTax", "OperatingProfit",
        "ProfitLossFromOperatingActivities", "PBIDT",
    )),
    ("Interest", ("FinanceCosts", "InterestExpense", "Interest")),
    ("Depreciation", (
        "DepreciationDepletionAndAmortisationExpense",
        "DepreciationAndAmortisationExpense",
        "DepreciationAmortisationExpense",
    )),
    ("Pre-Tax Income", (
        "ProfitBeforeTax", "ProfitLossBeforeTax",
        "ProfitBeforeExceptionalItemsAndTax",
        "ProfitLossBeforeExceptionalItemsAndTax",
    )),
    ("Tax Provision", (
        "TaxExpense", "TotalTaxExpense", "IncomeTaxExpense",
        "TaxExpenseTotal",
    )),
    ("Net Income", (
        "ProfitLossForPeriod", "ProfitLossForThePeriod",
        "NetProfitLossForThePeriod", "ProfitAfterTax",
        "ProfitLossForPeriodFromContinuingOperations",
    )),
    ("EPS (basic)", (
        "BasicEarningsLossPerShare", "BasicEarningsPerShare",
        "BasicEarningsLossPerShareFromContinuingOperations",
    )),
    ("EPS (diluted)", (
        "DilutedEarningsLossPerShare", "DilutedEarningsPerShare",
        "DilutedEarningsLossPerShareFromContinuingOperations",
    )),
]

# Fallback for a tag name spelled differently from every guess above. Each
# entry is a set of WORDS that must all appear among a tag's CamelCase-split
# tokens — `{revenue, operations}` matches `RevenueFromOperations` and
# `TotalRevenueFromOperations` but not `RevenueSegmentDisclosure`.
_FUZZY: dict[str, tuple[frozenset[str], ...]] = {
    "Revenue": (frozenset({"revenue", "operations"}), frozenset({"net", "sales"}),
                frozenset({"revenue"})),
    "Other income": (frozenset({"other", "income"}),),
    "Total income": (frozenset({"total", "income"}), frozenset({"income"})),
    "Total expenditure": (frozenset({"total", "expenses"}),
                          frozenset({"total", "expenditure"}),
                          frozenset({"expenses"})),
    "Operating Income": (frozenset({"operating", "profit"}),
                         frozenset({"pbidt"}), frozenset({"ebitda"})),
    "Interest": (frozenset({"finance", "costs"}), frozenset({"interest"})),
    "Depreciation": (frozenset({"depreciation"}),),
    "Pre-Tax Income": (frozenset({"profit", "before", "tax"}),
                       frozenset({"pbt"})),
    "Tax Provision": (frozenset({"tax", "expense"}),),
    "Net Income": (frozenset({"profit", "loss", "period"}),
                   frozenset({"profit", "after", "tax"}),
                   frozenset({"net", "profit"})),
    "EPS (basic)": (frozenset({"basic", "earnings", "share"}),
                    frozenset({"basic", "eps"})),
    "EPS (diluted)": (frozenset({"diluted", "earnings", "share"}),
                      frozenset({"diluted", "eps"})),
}

# A tag carrying any of these is a breakdown, a restatement or a discontinued
# stream — never the headline figure, however well its other words match.
_FUZZY_EXCLUDE = frozenset({
    "discontinued", "discontinuing", "prior", "restated", "previous",
    "segment", "percentage", "ratio", "note", "disclosure", "corresponding",
})

# Lines that are per-share rather than currency. They are never derived and
# never summed across quarters.
_PER_SHARE = frozenset({"EPS (basic)", "EPS (diluted)"})


def _tokens(name: str) -> set[str]:
    """`RevenueFromOperations` -> `{revenue, from, operations}`."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(name))
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", s)
    return set(re.split(r"[^a-z0-9]+", s.lower())) - {""}


def _fuzzy_match(available: dict[str, dict], line: str,
                 claimed: set[str]) -> str | None:
    """The best unclaimed tag satisfying one of `line`'s word-sets.

    Fewest tokens wins. That is what separates a total from its own
    components: `TaxExpense` beats `DeferredTaxExpense`, and
    `ProfitLossForPeriod` beats `ProfitLossForPeriodAttributableToOwners`.
    Ties break alphabetically so a parse is never order-dependent.
    """
    wordsets = _FUZZY.get(line)
    if not wordsets:
        return None
    best: tuple[int, str] | None = None
    for tag in available:
        if tag in claimed:
            continue
        toks = _tokens(tag)
        if toks & _FUZZY_EXCLUDE:
            continue
        if not any(ws <= toks for ws in wordsets):
            continue
        cand = (len(toks), tag)
        if best is None or cand < best:
            best = cand
    return best[1] if best else None


def extract_lines(tag_facts: dict[str, dict]) -> dict[str, dict]:
    """`{tag: fact}` for one period -> `{line: {tag, value, via}}`.

    Claiming is per-period: once a tag has supplied one line it is out of
    play for the rest, so a loose fuzzy match cannot put the same figure on
    two rows and make the statement appear to balance when it does not.
    """
    claimed: set[str] = set()
    out: dict[str, dict] = {}
    for line, tags in _LINES:
        tag_used: str | None = None
        via: str | None = None
        for t in tags:
            if t in tag_facts and t not in claimed:
                tag_used, via = t, "exact"
                break
        if tag_used is None:
            fz = _fuzzy_match(tag_facts, line, claimed)
            if fz is not None:
                tag_used, via = fz, "fuzzy"
        if tag_used is None:
            out[line] = {"tag": None, "value": None, "via": None, "unit": None}
            continue
        claimed.add(tag_used)
        fact = tag_facts[tag_used]
        out[line] = {"tag": tag_used, "value": fact["value"], "via": via,
                     "unit": fact.get("unit_ref"),
                     "decimals": fact.get("decimals"),
                     "scale": fact.get("scale")}
    return out


def _derive(lines: dict[str, dict], tag_facts: dict[str, dict]) -> None:
    """Fill lines the taxonomy states only as components, in place.

    Both derivations are arithmetic on figures already parsed, and each is
    labelled `derived` so a reader is never shown a computed number as
    something the company filed.
    """
    def val(line):
        return lines.get(line, {}).get("value")

    # Indian filings usually tag total tax only as its parts.
    if val("Tax Provision") is None:
        parts = [tag_facts.get(t, {}).get("value")
                 for t in ("CurrentTax", "DeferredTax",
                           "CurrentTaxExpense", "DeferredTaxExpense")]
        parts = [p for p in parts if p is not None]
        if parts:
            lines["Tax Provision"] = {"tag": "CurrentTax + DeferredTax",
                                      "value": sum(parts), "via": "derived",
                                      "unit": None}

    # PBIDT is rarely tagged; it is PBT with the two non-operating charges
    # added back. Only computed when all three inputs are real.
    if val("Operating Income") is None:
        pbt, interest, dep = (val("Pre-Tax Income"), val("Interest"),
                              val("Depreciation"))
        if None not in (pbt, interest, dep):
            lines["Operating Income"] = {
                "tag": "Pre-Tax Income + Interest + Depreciation",
                "value": pbt + interest + dep, "via": "derived", "unit": None}


# ── fetching ─────────────────────────────────────────────────────────────

_DOC_CACHE: dict[str, tuple[float, dict]] = {}
_DOC_TTL = 6 * 3600
_DOC_LOCK = threading.Lock()
# One filing's XBRL carries its own quarter plus the year-ago comparative, so
# a handful of documents covers the history the statement screens want. The
# cap is what stops a cold cache from making one page load fetch a decade.
_MAX_DOCS = 5


def filings(ticker: str, quarterly: bool = True) -> list[dict]:
    """The announcement index: one row per filing, with a link to its XBRL."""
    sym = nse._clean_symbol(ticker)
    if not sym:
        return []
    data = nse._get("/api/corporates-financial-results", {
        "index": "equities",
        "symbol": sym,
        "period": "Quarterly" if quarterly else "Annual",
    })
    rows = data if isinstance(data, list) else (data or {}).get("data") or []
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def _document_url(row: dict) -> str | None:
    """Where this filing's numbers live.

    `resultDetailedDataLink` is NSE's own detail view and is preferred when
    populated; it is null on most rows, which is why the XBRL is the path
    that actually matters.
    """
    for key in ("resultDetailedDataLink", "xbrl"):
        raw = row.get(key)
        if not raw:
            continue
        url = str(raw).strip()
        if url.startswith("/"):
            url = f"{nse.BASE}{url}"
        if url.lower().startswith("https://"):
            return url
    return None


def fetch_document(url: str) -> dict:
    """Fetch and parse one XBRL document, memoised for `_DOC_TTL`.

    Filings are immutable once published, so caching them is safe and keeps a
    statement page from re-fetching five documents on every render.
    """
    now = time.time()
    with _DOC_LOCK:
        hit = _DOC_CACHE.get(url)
        if hit and now - hit[0] < _DOC_TTL:
            return hit[1]
    text = nse.get_text(url)
    doc = (nse_xbrl.parse_document(text) if text
           else {"contexts": {}, "units": {}, "facts": [],
                 "error": "could not fetch document"})
    with _DOC_LOCK:
        _DOC_CACHE[url] = (now, doc)
    return doc


def _iso(raw) -> str | None:
    if not raw:
        return None
    from datetime import datetime as _dt
    s = str(raw).strip()
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return _dt.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def periods_from_document(doc: dict, shape: str = "quarter") -> dict[str, dict]:
    """`{period_end: {line: {...}}}` for every undimensioned period of `shape`.

    Restricting to the requested shape is what keeps a nine-month cumulative
    out of a quarterly column — the two sit side by side in the same document
    and differ only by their context's date span.
    """
    contexts = doc.get("contexts") or {}
    by_ctx = nse_xbrl.facts_by_context(doc.get("facts") or [])
    out: dict[str, dict] = {}
    for cid, ctx in contexts.items():
        if ctx.get("shape") != shape or ctx.get("dims") or not ctx.get("end"):
            continue
        tag_facts = by_ctx.get(cid) or {}
        if not tag_facts:
            continue
        lines = extract_lines(tag_facts)
        _derive(lines, tag_facts)
        if any(v["value"] is not None for v in lines.values()):
            out[ctx["end"]] = lines
    return out


def _mapped_count(lines: dict[str, dict]) -> int:
    return sum(1 for v in lines.values() if v.get("value") is not None)


def collect_periods(ticker: str, quarterly: bool = True,
                    max_docs: int = _MAX_DOCS) -> dict[str, dict]:
    """Merge every quarter found across the most recent filings.

    Where two filings both carry a period — the original and a later filing's
    comparative — the more complete extraction wins. A comparative column is
    often abbreviated, and taking it over the original would drop lines for
    no reason other than fetch order.
    """
    shape = "quarter" if quarterly else "year"
    merged: dict[str, dict] = {}
    for row in filings(ticker, quarterly=quarterly)[:max_docs]:
        url = _document_url(row)
        if not url:
            continue
        try:
            doc = fetch_document(url)
        except Exception:
            continue
        for end, lines in periods_from_document(doc, shape).items():
            if end not in merged or _mapped_count(lines) > _mapped_count(merged[end]):
                merged[end] = lines
    return merged


def financial_results(ticker: str, quarterly: bool = True,
                      max_docs: int = _MAX_DOCS) -> dict:
    """Income-statement history for an Indian listing.

    `max_docs` is a fetch budget, one HTTP request per document. A statement
    screen showing one company can afford the default; a screener walking a
    fifty-name universe cannot, and passes a smaller number — one document
    already carries a quarter and its year-ago comparative, which is all
    year-on-year growth needs.

    Returns the empty shape rather than raising when NSE is unreachable — the
    caller falls through to its other providers, and a screen that says
    "no data" is better than one that 500s.
    """
    try:
        periods = collect_periods(ticker, quarterly=quarterly, max_docs=max_docs)
    except Exception:
        periods = {}
    return build_statement(periods)


def build_statement(periods: dict[str, dict]) -> dict:
    """`{period_end: {line: {...}}}` -> `{columns, rows}`, oldest column first.

    Oldest-first because the statement screens read left to right as time, and
    a reversed series gives every growth rate the wrong sign.
    """
    # A period whose every line came back empty is a filing we could not read,
    # not a quarter the company had no results in. Keeping it would render an
    # empty column that reads as a real reporting gap.
    columns = sorted(c for c, lines in periods.items()
                     if any(v.get("value") is not None for v in lines.values()))
    if not columns:
        return {"columns": [], "rows": []}
    out_rows: list[dict] = []
    for line, _tags in _LINES:
        cells = {c: periods[c].get(line, {}).get("value") for c in columns}
        # A line no filing reported is a line this source does not carry.
        if any(v is not None for v in cells.values()):
            out_rows.append({"line": line, **cells})
    return {"columns": columns, "rows": out_rows}


# ── shareholding ──────────────────────────────────────────────────────────

def _num(v) -> float | None:
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


# ── derived series ────────────────────────────────────────────────────────

def latest_period(parsed: dict) -> str | None:
    cols = parsed.get("columns") or []
    return cols[-1] if cols else None


def series(parsed: dict, line: str) -> list[float | None]:
    """One line's values across the periods, oldest first."""
    for r in parsed.get("rows") or []:
        if r.get("line") == line:
            return [r.get(c) for c in parsed.get("columns") or []]
    return []


def _dated(parsed: dict, line: str) -> list[tuple[date, float]]:
    """(period end, value) for the periods that actually reported this line."""
    cols = parsed.get("columns") or []
    vals = series(parsed, line)
    out: list[tuple[date, float]] = []
    for col, v in zip(cols, vals):
        if v is None:
            continue
        try:
            out.append((date.fromisoformat(col), v))
        except ValueError:
            continue
    return sorted(out)


def trailing_twelve(parsed: dict, line: str) -> float | None:
    """Sum of the last four quarters, or None if they don't form a year.

    Counting four columns is not enough. Each filing's XBRL carries its own
    quarter and the year-ago comparative, so a series built from them can be
    SPARSE — four available columns may be Q3 of four different years, and
    summing those would report four years of revenue as one. The four have to
    span roughly a year end to end, or there is no trailing twelve months to
    report.

    Never valid for a per-share line: four quarterly EPS figures summed is not
    an annual EPS.
    """
    if line in _PER_SHARE:
        return None
    pts = _dated(parsed, line)
    if len(pts) < 4:
        return None
    window = pts[-4:]
    span = (window[-1][0] - window[0][0]).days
    # Three quarter-gaps between four consecutive quarter-ends is ~273 days;
    # anything much wider means the columns skip quarters.
    if not 250 <= span <= 290:
        return None
    return sum(v for _d, v in window)


# A year either side of a period end, with room for the fact that Indian
# quarter ends move by a day or two and a filing occasionally covers 13 weeks.
_YEAR_MIN, _YEAR_MAX = 320, 410


def yoy_growth(parsed: dict, line: str) -> float | None:
    """Latest quarter against the same quarter a year earlier, in percent.

    Year-on-year rather than sequential because Indian results are seasonal —
    a Q3 festive quarter against Q2 measures the calendar, not the business.

    The comparison period is found BY DATE, not by counting four columns back.
    A series assembled from XBRL filings is sparse — one document supplies a
    quarter and its year-ago comparative and nothing between — so counting
    columns lands on whatever happens to be there, which can be two years back
    or a different quarter entirely.
    """
    pts = _dated(parsed, line)
    if len(pts) < 2:
        return None
    latest_d, latest = pts[-1]
    base = None
    for d, v in reversed(pts[:-1]):
        gap = (latest_d - d).days
        if _YEAR_MIN <= gap <= _YEAR_MAX:
            base = v
            break
        if gap > _YEAR_MAX:
            break
    if base is None:
        return None
    # A sign flip makes a percentage change meaningless: -10 to +5 is not
    # "150% growth", it is a company that stopped losing money.
    if base == 0 or (base < 0) != (latest < 0):
        return None
    return ((latest - base) / abs(base)) * 100


# ── diagnostics ───────────────────────────────────────────────────────────

def consistency(lines: dict[str, dict]) -> list[dict]:
    """The identities a real income statement has to satisfy.

    This is the part that makes a mapping checkable without knowing the
    company's true figures. Revenue plus other income IS total income in any
    filing, whatever the tags are called; if the parse says otherwise, a line
    is on the wrong row. Net income over EPS gives a share count, which is the
    scale check — it is a pure ratio, so it lands in the right range only when
    the currency lines and the per-share lines agree about their units.
    """
    def v(line):
        return lines.get(line, {}).get("value")

    checks: list[dict] = []

    def rel(name, got, want, tol=0.02, detail=""):
        if got is None or want is None:
            checks.append({"check": name, "status": "skipped",
                           "reason": "an input line is missing", "detail": detail})
            return
        denom = max(abs(want), 1.0)
        off = abs(got - want) / denom
        checks.append({
            "check": name,
            "status": "ok" if off <= tol else "MISMATCH",
            "got": got, "expected": want,
            "off_by_pct": round(off * 100, 2), "detail": detail,
        })

    rev, oth, tot = v("Revenue"), v("Other income"), v("Total income")
    rel("revenue + other income = total income",
        None if rev is None or oth is None else rev + oth, tot,
        detail="a mismatch means one of the three is mapped to the wrong tag")

    inc, exp, pbt = v("Total income"), v("Total expenditure"), v("Pre-Tax Income")
    rel("total income - total expenditure = pre-tax income",
        None if inc is None or exp is None else inc - exp, pbt,
        # Exceptional items and share of associates sit between these two
        # lines, so a few percent of drift is normal rather than a fault.
        tol=0.05,
        detail="drift up to a few percent is normal (exceptional items)")

    pat = v("Net Income")
    rel("pre-tax income - tax = net income",
        None if pbt is None or v("Tax Provision") is None else pbt - v("Tax Provision"),
        pat, tol=0.05,
        detail="minority interest sits between these two for a group filing")

    eps = v("EPS (basic)")
    if pat is not None and eps not in (None, 0):
        shares = pat / eps
        # Any real listed company sits between a few million and a trillion
        # shares. A currency line mis-scaled against a per-share line lands
        # this ratio orders of magnitude outside that, which is the signature
        # of a scale error rather than a mapping one.
        plausible = 1e6 <= abs(shares) <= 1e12
        checks.append({
            "check": "net income / EPS = a plausible share count",
            "status": "ok" if plausible else "MISMATCH",
            "got": round(shares, 1),
            "detail": ("implied shares outstanding; outside 1e6–1e12 means the "
                       "currency lines and the per-share lines disagree about "
                       "scale"),
        })
    else:
        checks.append({"check": "net income / EPS = a plausible share count",
                       "status": "skipped",
                       "reason": "net income or EPS is missing"})
    return checks


def probe(ticker: str, quarterly: bool = True, max_docs: int = 2) -> dict:
    """The filing's raw XBRL next to what got parsed out of it.

    Reports every numeric tag in the chosen period, not just the ones that
    matched, so a tag name still spelled wrong here can be corrected from one
    run of this endpoint rather than another guess.
    """
    sym = nse._clean_symbol(ticker)
    if not sym:
        return {"ticker": ticker, "ok": False, "reason": "not a recognised ticker"}

    rows = filings(ticker, quarterly=quarterly)
    if not rows:
        return {"ticker": ticker, "ok": False,
                "reason": "NSE returned no filings (session warm-up, rate limit, "
                          "or an unknown symbol)"}

    docs: list[dict] = []
    for row in rows[:max_docs]:
        url = _document_url(row)
        entry = {
            "period": f"{row.get('fromDate')} .. {row.get('toDate')}",
            "relating_to": row.get("relatingTo"),
            "consolidated": row.get("consolidated"),
            "source_field": ("resultDetailedDataLink"
                             if row.get("resultDetailedDataLink") else "xbrl"),
            "url": url,
        }
        if not url:
            entry["error"] = "filing row carried no document link"
            docs.append(entry)
            continue
        try:
            doc = fetch_document(url)
        except Exception as exc:
            entry["error"] = f"fetch/parse failed: {exc}"
            docs.append(entry)
            continue
        if doc.get("error"):
            entry["error"] = doc["error"]
            docs.append(entry)
            continue

        want_end = _iso(row.get("toDate"))
        by_ctx = nse_xbrl.facts_by_context(doc["facts"])
        shape = "quarter" if quarterly else "year"
        cid = (nse_xbrl.choose_context(doc["contexts"], shape, want_end)
               or nse_xbrl.choose_context(doc["contexts"], shape))
        entry["context_used"] = doc["contexts"].get(cid) if cid else None
        entry["contexts_available"] = sorted(
            {f"{c['shape']}: {c['start']}..{c['end']}"
             for c in doc["contexts"].values() if c.get("shape")})
        entry["units"] = doc.get("units")

        tag_facts = by_ctx.get(cid) or {}
        lines = extract_lines(tag_facts)
        _derive(lines, tag_facts)
        entry["mapping"] = [
            {"line": line, "matched_tag": lines[line]["tag"],
             "matched_via": lines[line]["via"], "value": lines[line]["value"]}
            for line, _t in _LINES
        ]
        entry["unmapped_lines"] = [line for line, _t in _LINES
                                   if lines[line]["value"] is None]
        # Everything present in this period, biggest first — the definitive
        # answer to "what is the tag actually called".
        entry["all_numeric_facts"] = [
            {"tag": t, "value": f["value"], "decimals": f.get("decimals"),
             "unit": f.get("unit_ref")}
            for t, f in sorted(tag_facts.items(),
                               key=lambda kv: -abs(kv[1]["value"]))
        ]
        entry["consistency"] = consistency(lines)
        docs.append(entry)

    ok = any(d.get("mapping") for d in docs)
    return {
        "ticker": ticker,
        "ok": ok,
        "filings_seen": len(rows),
        "index_row_keys": sorted(rows[0].keys()),
        "documents": docs,
        "parsed": build_statement(collect_periods(ticker, quarterly=quarterly,
                                                  max_docs=max_docs)) if ok else
                  {"columns": [], "rows": []},
    }
