"""XBRL instance-document parsing, for NSE's financial-results filings.

NSE's /api/corporates-financial-results endpoint returns an ANNOUNCEMENT
INDEX — company name, period, ISIN, audited flag, and a link to the filing.
It carries no financial line items at all. The numbers live in the XBRL
document that row points at, under `xbrl`:

    https://nsearchives.nseindia.com/corporate/xbrl/INDAS_117298_....xml

This module parses that document. It is deliberately pure — text in, facts
out, no network — so every rule below is testable without reaching NSE.

Three things here are correctness hazards rather than conveniences:

CONTEXTS. An Indian results filing reports the quarter AND its comparatives
in one document: the current quarter, the year-ago quarter, the 9-month
cumulative, and the prior full year are all present, each fact tagged with a
`contextRef`. Reading a fact without checking which period its context covers
is how a 9-month cumulative revenue ends up in a quarterly column, overstating
it threefold. Durations are classified by day-count and cumulative periods are
kept separate from quarters.

SCALE. In an XBRL instance document the reported value IS the value, in the
unit named by `unitRef` — `decimals="-7"` means "accurate to the nearest
crore", it is a PRECISION statement, not a multiplier. Treating it as a
multiplier is a 10-million-fold error. Only an explicit `scale` attribute
(inline XBRL) is applied, and both attributes are reported so the decision is
auditable rather than assumed.

NIL FACTS. `xsi:nil="true"` means the company reported the line as absent.
That is not zero, and the difference matters for every margin computed from it.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from xml.etree import ElementTree

XBRLI = "http://www.xbrl.org/2003/instance"
XSI = "http://www.w3.org/2001/XMLSchema-instance"

# Day-counts for the period shapes an Indian results filing contains. Indian
# quarters run 90-92 days; the windows are wide enough for calendar drift and
# narrow enough that a quarter can never be read as a half-year.
_SHAPES: list[tuple[str, int, int]] = [
    ("quarter", 80, 100),
    ("half", 170, 195),
    ("nine_month", 260, 285),
    ("year", 350, 380),
]


def local_name(tag: str) -> str:
    """Strip whichever way this name carries its namespace.

    ElementTree hands back element tags as `{uri}Local`, but a `dimension`
    attribute and an explicit member are QNames written `prefix:Local` — both
    forms turn up in one context, so both have to reduce to the same thing.
    """
    name = tag.rsplit("}", 1)[-1] if "}" in tag else tag
    return name.rsplit(":", 1)[-1]


def _text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def _parse_date(s: str) -> date | None:
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def period_shape(start: date | None, end: date | None) -> str | None:
    """Which reporting window a duration is, or None if it matches none.

    An unrecognised span is deliberately unnamed rather than forced into the
    nearest bucket — a 45-day stub period is not a quarter, and calling it one
    would put a half-quarter's revenue in a quarterly column.
    """
    if not start or not end:
        return None
    days = (end - start).days + 1
    for name, lo, hi in _SHAPES:
        if lo <= days <= hi:
            return name
    return None


def parse_contexts(root) -> dict[str, dict]:
    """`{context_id: {start, end, instant, shape, dims}}`.

    `dims` carries any explicit segment members (consolidated/standalone,
    segment reporting, and so on). Contexts with no dimensions are the
    filing's primary figures; anything dimensioned is a breakdown of them,
    and summing the two would double-count.
    """
    out: dict[str, dict] = {}
    for ctx in root.iter(f"{{{XBRLI}}}context"):
        cid = ctx.get("id")
        if not cid:
            continue
        start = end = instant = None
        period = ctx.find(f"{{{XBRLI}}}period")
        if period is not None:
            start = _parse_date(_text(period.find(f"{{{XBRLI}}}startDate")))
            end = _parse_date(_text(period.find(f"{{{XBRLI}}}endDate")))
            instant = _parse_date(_text(period.find(f"{{{XBRLI}}}instant")))
        dims: list[tuple[str, str]] = []
        for seg in ctx.iter():
            axis = seg.get("dimension")
            if axis:
                dims.append((local_name(axis), local_name(_text(seg))))
        out[cid] = {
            "id": cid,
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            "instant": instant.isoformat() if instant else None,
            "shape": period_shape(start, end),
            "dims": dims,
        }
    return out


def parse_units(root) -> dict[str, str]:
    """`{unit_id: 'iso4217:INR'}` — what a number is actually denominated in."""
    out: dict[str, str] = {}
    for unit in root.iter(f"{{{XBRLI}}}unit"):
        uid = unit.get("id")
        if not uid:
            continue
        measures = [_text(m) for m in unit.iter(f"{{{XBRLI}}}measure")]
        out[uid] = " / ".join(m for m in measures if m)
    return out


_NUM = re.compile(r"^-?\d+(\.\d+)?$")


def parse_facts(root) -> list[dict]:
    """Every numeric fact in the document, with the context it belongs to.

    Nil facts are skipped: `xsi:nil="true"` is the company saying the line is
    absent, which is not the same claim as zero.
    """
    facts: list[dict] = []
    for el in root.iter():
        ctx_ref = el.get("contextRef")
        if not ctx_ref:
            continue
        if (el.get(f"{{{XSI}}}nil") or "").lower() == "true":
            continue
        raw = (el.text or "").strip().replace(",", "")
        if not raw or not _NUM.match(raw):
            continue
        value = float(raw)
        # Inline XBRL only. A plain instance document states actual values, so
        # `scale` is normally absent and applying anything here would be an
        # invented multiplier.
        scale = el.get("scale")
        if scale is not None:
            try:
                value *= 10 ** int(scale)
            except (TypeError, ValueError):
                scale = None
        if (el.get("sign") or "") == "-":
            value = -value
        facts.append({
            "tag": local_name(el.tag),
            "context_ref": ctx_ref,
            "unit_ref": el.get("unitRef"),
            # Kept for the diagnostic, never used as a multiplier: `decimals`
            # is a precision statement ("accurate to the nearest crore"), and
            # reading it as a scale is a 10-million-fold error.
            "decimals": el.get("decimals"),
            "scale": scale,
            "raw": raw,
            "value": value,
        })
    return facts


def parse_document(xml_text: str) -> dict:
    """A whole XBRL instance -> `{contexts, units, facts}`.

    Returns the empty shape rather than raising on malformed XML: a filing
    NSE serves as an error page should degrade to "no data", not a 500.
    """
    if not xml_text or not xml_text.strip():
        return {"contexts": {}, "units": {}, "facts": [], "error": "empty document"}
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        return {"contexts": {}, "units": {}, "facts": [], "error": f"not XML: {exc}"}
    return {
        "contexts": parse_contexts(root),
        "units": parse_units(root),
        "facts": parse_facts(root),
        "error": None,
    }


def choose_context(contexts: dict[str, dict], shape: str = "quarter",
                   end: str | None = None) -> str | None:
    """The context id whose period is the one being asked for.

    Prefers an exact end-date match, then the latest period of the right
    shape. Undimensioned contexts always win: a dimensioned context is a
    segment or a standalone/consolidated breakdown OF the primary figures,
    and picking one silently reports a division's revenue as the group's.
    """
    candidates = [c for c in contexts.values() if c.get("shape") == shape]
    if not candidates:
        return None
    plain = [c for c in candidates if not c["dims"]]
    pool = plain or candidates
    if end:
        exact = sorted([c for c in pool if c["end"] == end],
                       key=lambda c: c["id"])
        # No substitute when a specific period was asked for: returning the
        # nearest quarter instead would put Q2's numbers under Q3's heading.
        return exact[0]["id"] if exact else None
    pool = sorted(pool, key=lambda c: (c["end"] or "", c["id"]))
    return pool[-1]["id"] if pool else None


def facts_by_context(facts: list[dict]) -> dict[str, dict[str, dict]]:
    """`{context_id: {tag: fact}}`.

    A tag repeated within one context keeps the FIRST occurrence; duplicates
    in a results filing are the same figure restated, and picking arbitrarily
    between them would make the parse non-deterministic.
    """
    out: dict[str, dict[str, dict]] = {}
    for f in facts:
        bucket = out.setdefault(f["context_ref"], {})
        bucket.setdefault(f["tag"], f)
    return out
