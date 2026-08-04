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
    # Consolidation lines. A group's profit does not go straight from pre-tax
    # to net: equity-accounted associates come in, and the slice belonging to
    # outside shareholders of part-owned subsidiaries comes out. Leaving them
    # out is what made the reconciliation an approximation.
    ("Share of associates", (
        "ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod",
        "ShareOfProfitLossOfAssociatesAndJointVentures",
        "ShareOfProfitLossOfAssociates", "ShareOfProfitOfAssociates",
    )),
    ("Exceptional items", (
        "ExceptionalItems", "ExceptionalItemsBeforeTax",
        "ExceptionalItemsIncomeLoss",
    )),
    ("Net Income", (
        "ProfitLossForPeriod", "ProfitLossForThePeriod",
        "NetProfitLossForThePeriod", "ProfitAfterTax",
        "ProfitLossForPeriodFromContinuingOperations",
    )),
    # The slice of that profit belonging to outside shareholders of part-owned
    # subsidiaries. Reliance consolidates Jio and Retail without owning all of
    # either, so this is a real deduction, not a rounding artefact.
    ("Non-controlling interests", (
        "ProfitLossAttributableToNonControllingInterests",
        "ProfitLossAttributableToNoncontrollingInterests",
        "ShareOfProfitLossAttributableToNonControllingInterests",
        "MinorityInterest",
    )),
    # What the parent's own shareholders earned, and the only profit figure
    # EPS is computed on. Dividing GROUP profit by EPS overstates the implied
    # share count by exactly the minority slice.
    ("Net Income (owners)", (
        "ProfitLossAttributableToOwnersOfParent",
        "ProfitLossAttributableToOwnersOfTheParent",
        "ProfitLossAttributableToEquityHoldersOfParent",
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
    "Share of associates": (frozenset({"share", "associates"}),
                            frozenset({"equity", "method", "profit"})),
    "Exceptional items": (frozenset({"exceptional"}),),
    "Net Income": (frozenset({"profit", "loss", "period"}),
                   frozenset({"profit", "after", "tax"}),
                   frozenset({"net", "profit"})),
    # `Noncontrolling` has no internal capital, so it survives the CamelCase
    # split as one token; both spellings have to be listed.
    "Non-controlling interests": (frozenset({"non", "controlling"}),
                                  frozenset({"noncontrolling"}),
                                  frozenset({"minority", "interest"})),
    "Net Income (owners)": (frozenset({"attributable", "owners"}),
                            frozenset({"attributable", "equity", "holders"})),
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

# Words that disqualify a tag for ONE line but are required by another, so
# they cannot live in the global exclusion set. Every profit subtotal in a
# consolidated filing is some `ProfitLossAttributableTo...`; without this the
# group's total profit line would claim the parent-owners figure and the
# minority deduction would vanish into a rounding-looking gap.
_LINE_EXCLUDE: dict[str, frozenset[str]] = {
    "Revenue": frozenset({"attributable"}),
    "Total income": frozenset({"attributable"}),
    "Pre-Tax Income": frozenset({"attributable"}),
    "Net Income": frozenset({"attributable", "owners", "minority",
                             "controlling", "noncontrolling", "holders"}),
}

# Lines that are per-share rather than currency. They are never derived and
# never summed across quarters.
_PER_SHARE = frozenset({"EPS (basic)", "EPS (diluted)"})

# Lines only some filings have. A standalone filer has no minority interest
# and no associates by construction, and a quarter with no exceptional items
# does not report the line at all. Keeping these out of `unmapped_lines`
# is what stops that field from filling with expected absences and losing its
# meaning as "a tag name we failed to find".
_OPTIONAL_LINES = frozenset({
    "Share of associates", "Exceptional items",
    "Non-controlling interests", "Net Income (owners)",
})


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
    banned = _FUZZY_EXCLUDE | _LINE_EXCLUDE.get(line, frozenset())
    best: tuple[int, str] | None = None
    for tag in available:
        if tag in claimed:
            continue
        toks = _tokens(tag)
        if toks & banned:
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


# ── which filing is the primary one ──────────────────────────────────────

# A company files the same quarter twice — once for the parent alone, once
# for the group. Picking arbitrarily between them is worse than it sounds: a
# series that takes consolidated for one quarter and standalone for the next
# shows a growth rate that is really just a change of reporting basis.
CONSOLIDATED, STANDALONE = "consolidated", "standalone"

# Consolidated is the default because it is the whole economic entity a share
# is a claim on, which is what almost every valuation wants.
#
# Banks are the deliberate exception. A bank's consolidated accounts fold in
# insurance, asset-management and broking subsidiaries whose economics have
# almost nothing in common with lending, so the consolidated margin, cost
# ratio and asset quality are blends of unlike businesses; the standard
# treatment is to read the bank standalone and value the subsidiaries
# separately. HOLDING companies are NOT on this list and must not be added —
# for Bajaj Finserv or an ABC-type holdco the standalone entity is close to
# an empty shell, and preferring it would report almost nothing as the whole
# company.
PREFER_STANDALONE: frozenset[str] = frozenset({
    "SBIN", "ICICIBANK", "HDFCBANK", "KOTAKBANK", "AXISBANK", "INDUSINDBK",
    "BANKBARODA", "PNB", "CANBK", "UNIONBANK", "IDFCFIRSTB", "FEDERALBNK",
    "BANDHANBNK", "AUBANK", "RBLBANK", "YESBANK", "IDBI", "INDIANB",
    "BANKINDIA", "CENTRALBK", "UCOBANK", "IOB", "MAHABANK", "PSB",
})


def preferred_basis(ticker: str) -> str:
    """Which reporting basis this ticker's statements should be read on."""
    sym = (nse._clean_symbol(ticker) or "").upper()
    return STANDALONE if sym in PREFER_STANDALONE else CONSOLIDATED


def filing_basis(row: dict) -> str | None:
    """Read the basis off an index row.

    NSE has used "Consolidated", "Non-Consolidated" and "Standalone" in this
    field across API revisions, so the test is on the leading token rather
    than an exact string — "Non-Consolidated" starting with "non" is what
    separates it from "Consolidated", and matching on a substring would call
    it consolidated.
    """
    raw = str(row.get("consolidated") or row.get("re_consolidated") or "").strip().lower()
    if not raw:
        return None
    if raw.startswith("non") or raw.startswith("stand") or raw.startswith("un-cons"):
        return STANDALONE
    if raw.startswith("cons"):
        return CONSOLIDATED
    return None


def _period_key(row: dict) -> str:
    return f"{_iso(row.get('fromDate')) or row.get('fromDate')}" \
           f"..{_iso(row.get('toDate')) or row.get('toDate')}"


def mark_primary(rows: list[dict], prefer: str) -> list[bool]:
    """One primary filing per period, by reporting basis.

    Returns a flag per row, aligned to `rows`. Within a period the preferred
    basis wins; if only the other basis was filed, that one is primary rather
    than leaving the period with none — a standalone-only quarter is still
    the quarter.
    """
    best: dict[str, int] = {}
    for i, row in enumerate(rows):
        key = _period_key(row)
        incumbent = best.get(key)
        if incumbent is None:
            best[key] = i
            continue
        if filing_basis(rows[incumbent]) == prefer:
            continue
        if filing_basis(row) == prefer:
            best[key] = i
    chosen = set(best.values())
    return [i in chosen for i in range(len(rows))]


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
                    max_docs: int = _MAX_DOCS,
                    prefer: str | None = None) -> dict[str, dict]:
    """Merge every quarter found across the most recent filings.

    Only PRIMARY filings are read. A company files each quarter twice, parent
    and group, and mixing the two produces a series whose growth rate is
    partly just a change of reporting basis — the standalone quarter next to
    the consolidated one looks like a collapse in revenue that never happened.

    Where two filings still carry the same period — a filing and a later
    filing's year-ago comparative — the more complete extraction wins, since
    a comparative column is often abbreviated and taking it would drop lines
    for no reason other than fetch order.
    """
    shape = "quarter" if quarterly else "year"
    prefer = prefer or preferred_basis(ticker)
    rows = filings(ticker, quarterly=quarterly)
    primary = mark_primary(rows, prefer)
    merged: dict[str, dict] = {}
    used = 0
    for row, is_primary in zip(rows, primary):
        if used >= max_docs:
            break
        if not is_primary:
            continue
        url = _document_url(row)
        if not url:
            continue
        used += 1
        try:
            doc = fetch_document(url)
        except Exception:
            continue
        for end, lines in periods_from_document(doc, shape).items():
            if end not in merged or _mapped_count(lines) > _mapped_count(merged[end]):
                merged[end] = lines
    return merged


def financial_results(ticker: str, quarterly: bool = True,
                      max_docs: int = _MAX_DOCS,
                      prefer: str | None = None) -> dict:
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
        periods = collect_periods(ticker, quarterly=quarterly,
                                  max_docs=max_docs, prefer=prefer)
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

# XBRL values are rounded — `decimals="-7"` means the filer rounded to the
# nearest crore — so summing three of them can miss by a few crore on a
# multi-trillion figure. This is a ROUNDING allowance, not slack for a term
# the identity forgot: at 0.05% a genuine missing line item never hides here.
_ROUND_TOL = 0.0005
_ROUND_FLOOR = 1e6


def _balances(got: float, want: float) -> tuple[bool, float]:
    residual = got - want
    allowed = max(abs(want) * _ROUND_TOL, _ROUND_FLOOR)
    return abs(residual) <= allowed, residual


def _reconcile(name: str, base: float | None, target: float | None,
               adjustments: list[tuple[str, float | None]],
               base_formula: str, detail: str = "") -> dict:
    """Check `base ± adjustments = target`, solving for the signs.

    Ind-AS lets a filer present the same term on either side of a subtotal,
    and sometimes on neither. Exceptional items are filed as a positive charge
    by some companies and a negative one by others. Share of associates
    appears before the tax line for most filers and after it for some — and
    when it is before, it is ALREADY inside the pre-tax subtotal, so applying
    it again double-counts it.

    So each adjustment has three states, not two: absent, added, subtracted.
    Every combination is tried and the one that balances is reported with the
    formula it used, which keeps this an identity rather than a tolerance wide
    enough to swallow a real error.
    """
    if base is None or target is None:
        return {"check": name, "status": "skipped",
                "reason": "an input line is missing", "detail": detail}

    terms = [(label, val) for label, val in adjustments if val is not None]
    best: dict | None = None
    for combo in range(3 ** len(terms)):
        total = base
        parts = [base_formula]
        for i, (label, val) in enumerate(terms):
            state = combo // (3 ** i) % 3
            if state == 1:
                total += val
                parts.append(f"+ {label}")
            elif state == 2:
                total -= val
                parts.append(f"- {label}")
        ok, residual = _balances(total, target)
        cand = {
            "check": name,
            "status": "ok" if ok else "MISMATCH",
            "formula": " ".join(parts),
            "got": total, "expected": target,
            "residual": round(residual, 2),
            "off_by_pct": round(abs(residual) / max(abs(target), 1.0) * 100, 4),
            "detail": detail,
        }
        # Closest to balancing wins. Ties go to the earliest combination,
        # which applies no adjustments at all, so a filing whose subtotal
        # already includes a term reports the plain identity rather than a
        # contrived pair of cancelling ones.
        if best is None or (not ok, abs(residual)) < \
                (best["status"] != "ok", abs(best["residual"])):
            best = cand
    return best


def consistency(lines: dict[str, dict], basis: str | None = None) -> list[dict]:
    """The identities a real income statement has to satisfy.

    This is what makes a mapping checkable without knowing the company's true
    figures. Revenue plus other income IS total income in any filing, whatever
    the tags are called; if the parse says otherwise, a line is on the wrong
    row.

    For a CONSOLIDATED filing the profit chain has two more steps, and leaving
    them out is what made this an approximation with a tolerance rather than
    an identity:

        total income - expenses ± exceptional + share of associates = pre-tax
        pre-tax - tax                                               = group profit
        group profit - non-controlling interests                    = owners' profit
        owners' profit / EPS                                        = share count

    The last one matters more than it looks. EPS is computed on the PARENT
    owners' profit, so dividing group profit by EPS overstates the implied
    share count by exactly the minority slice — which for a group like
    Reliance, consolidating Jio and Retail without owning all of either, is
    the sub-percent discrepancy that showed up as "close enough".
    """
    def v(line):
        return lines.get(line, {}).get("value")

    checks: list[dict] = []

    rev, oth, tot = v("Revenue"), v("Other income"), v("Total income")
    checks.append(_reconcile(
        "revenue + other income = total income",
        rev, tot, [("other income", oth)], "revenue",
        detail="a mismatch means one of the three is mapped to the wrong tag"))

    inc, exp, pbt = v("Total income"), v("Total expenditure"), v("Pre-Tax Income")
    checks.append(_reconcile(
        "total income - expenditure (± exceptional, associates) = pre-tax income",
        None if inc is None or exp is None else inc - exp, pbt,
        [("exceptional items", v("Exceptional items")),
         ("share of associates", v("Share of associates"))],
        "total income - expenditure",
        detail="associates and exceptional items sit between these two lines; "
               "both are pulled in rather than tolerated as drift"))

    tax, group = v("Tax Provision"), v("Net Income")
    checks.append(_reconcile(
        "pre-tax income - tax = profit for the period",
        None if pbt is None or tax is None else pbt - tax, group,
        # A filer that presents associates AFTER the tax line needs it here
        # instead; whichever placement balances is the one reported.
        [("share of associates", v("Share of associates"))],
        "pre-tax income - tax",
        detail="profit for the period is the GROUP total, before the minority "
               "slice is taken out"))

    nci, owners = v("Non-controlling interests"), v("Net Income (owners)")
    if nci is None and owners is None:
        checks.append({
            "check": "profit for the period - minority = owners' profit",
            "status": "skipped",
            "reason": ("no consolidation lines in this filing"
                       + (" (expected for a standalone filing)"
                          if basis == "standalone" else "")),
        })
    else:
        checks.append(_reconcile(
            "profit for the period - minority = owners' profit",
            group, owners, [("non-controlling interests", nci)],
            "profit for the period",
            detail="the slice belonging to outside shareholders of part-owned "
                   "subsidiaries"))

    # EPS is struck on the parent owners' earnings, so that is the numerator.
    # Group profit here is what made the share count read ~0.6% high.
    eps = v("EPS (basic)")
    earnings = owners if owners is not None else group
    which = "owners' profit" if owners is not None else "profit for the period"
    if earnings is not None and eps not in (None, 0):
        shares = earnings / eps
        # Any real listed company sits between a few million and a trillion
        # shares. A currency line mis-scaled against a per-share line lands
        # this ratio orders of magnitude outside that, which is the signature
        # of a scale error rather than a mapping one.
        plausible = 1e6 <= abs(shares) <= 1e12
        checks.append({
            "check": f"{which} / EPS = a plausible share count",
            "status": "ok" if plausible else "MISMATCH",
            "got": round(shares, 1),
            "numerator": which,
            "detail": ("implied shares outstanding; outside 1e6–1e12 means the "
                       "currency lines and the per-share lines disagree about "
                       "scale"),
        })
    else:
        checks.append({"check": "owners' profit / EPS = a plausible share count",
                       "status": "skipped",
                       "reason": "the profit line or EPS is missing"})
    return checks


def probe(ticker: str, quarterly: bool = True, max_docs: int = 2,
          prefer: str | None = None) -> dict:
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

    prefer = prefer or preferred_basis(ticker)
    primary_flags = mark_primary(rows, prefer)

    docs: list[dict] = []
    for row, is_primary in list(zip(rows, primary_flags))[:max_docs]:
        url = _document_url(row)
        basis = filing_basis(row)
        entry = {
            "period": f"{row.get('fromDate')} .. {row.get('toDate')}",
            "relating_to": row.get("relatingTo"),
            "consolidated": row.get("consolidated"),
            "basis": basis,
            "primary": is_primary,
            "primary_reason": (
                f"preferred basis for this ticker is {prefer}"
                if is_primary and basis == prefer else
                "only filing for this period" if is_primary else
                f"a {prefer} filing exists for the same period"),
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
                                   if lines[line]["value"] is None
                                   and line not in _OPTIONAL_LINES]
        # Absent by construction rather than by a failed match: a standalone
        # filer has no minority interest, and a clean quarter files no
        # exceptional item. Listed separately so the field above keeps
        # meaning "a tag we could not find".
        entry["optional_absent"] = [line for line, _t in _LINES
                                    if lines[line]["value"] is None
                                    and line in _OPTIONAL_LINES]
        # Everything present in this period, biggest first — the definitive
        # answer to "what is the tag actually called".
        entry["all_numeric_facts"] = [
            {"tag": t, "value": f["value"], "decimals": f.get("decimals"),
             "unit": f.get("unit_ref")}
            for t, f in sorted(tag_facts.items(),
                               key=lambda kv: -abs(kv[1]["value"]))
        ]
        entry["consistency"] = consistency(lines, basis=basis)
        docs.append(entry)

    ok = any(d.get("mapping") for d in docs)
    selected = next((i for i, d in enumerate(docs) if d.get("primary")), None)
    return {
        "ticker": ticker,
        "ok": ok,
        "filings_seen": len(rows),
        "preferred_basis": prefer,
        # Which entry of `documents` downstream code should treat as the
        # company's figures for its period. None means every filing in this
        # window was superseded by a preferred-basis one outside it.
        "selected_index": selected,
        "index_row_keys": sorted(rows[0].keys()),
        "documents": docs,
        "parsed": build_statement(
            collect_periods(ticker, quarterly=quarterly, max_docs=max_docs,
                            prefer=prefer)) if ok else
                  {"columns": [], "rows": []},
    }
