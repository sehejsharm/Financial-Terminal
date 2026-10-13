"""CSP violation reports: somewhere for them to go.

THE GAP THIS CLOSES. frontend/next.config.js ships Content-Security-Policy in
REPORT-ONLY mode, and documents the reasoning at length: script-src cannot be
enforced on Next 14's App Router without either 'unsafe-inline' (pointless) or
per-request nonces (which throw away static rendering, and Next 14.2.x carries
a nonce-related advisory). Report-only is the right call.

But there was no report endpoint anywhere in the repo. `report-uri` and
`report-to` were both absent, so every violation went to the browser console of
whoever happened to have devtools open and nowhere else. A report-only policy
with no collector is not a weaker control than an enforced one — it is not a
control at all. It looks like one on an audit checklist, which is worse than an
acknowledged gap.

WHAT THIS IS FOR, CONCRETELY. Two questions that cannot be answered without it:

  1. Is the policy ready to enforce? next.config.js's own measurement (42
     violations, all inline script) was taken by hand in a browser against six
     routes on one day. That is not something anyone will redo before flipping
     CSP_ENFORCE, and the honest prerequisite for flipping it is "the only
     violations arriving are ones we have hashed".
  2. Is something injecting script into the app right now? An XSS that CSP
     would have blocked shows up here as a violation for a blocked-uri nobody
     recognises. In report-only mode it is not blocked — but it is at least
     visible, and visible is the whole value of this endpoint.

DESIGN NOTES, because an unauthenticated POST endpoint on a financial app
deserves them:

  * UNAUTHENTICATED, necessarily. Browsers deliberately send violation reports
    without credentials, and the violation that matters most is the one on the
    sign-in page, before any session exists. So this is a public write surface
    and is treated as one.
  * AGGREGATED, NOT LOGGED LINE BY LINE. One broken page in one browser can
    emit thousands of identical reports. Writing each to the journal turns a
    CSS mistake into a disk-space incident on a 1GB VM. Reports collapse onto
    (directive, blocked-uri, document path) with a count and first/last seen.
  * BOUNDED. The aggregate is capped, because the key includes attacker-chosen
    strings — a sender varying blocked-uri could otherwise grow it without
    limit. Past the cap, new keys are dropped and counted as overflow, rather
    than evicting the real findings to make room for noise.
  * NOTHING IS TRUSTED. Every field arrives from a browser that may be lying.
    Values are truncated hard and the query string is stripped from
    document-uri before storage.
  * NEVER RAISES. Browsers send several different shapes here (the legacy
    `{"csp-report": {...}}` and the Reporting API's `[{type, body}]` batch),
    and new ones appear. A 422 from request validation would be a self-inflicted
    error on a path whose entire job is to accept whatever arrives.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request, Response

from backend.auth import require_master_admin

log = logging.getLogger("motherboard.csp")
router = APIRouter(tags=["security"])

#: Distinct violation signatures held in memory. Past this, new signatures are
#: dropped and counted. 500 is far more than a healthy app produces — the
#: hand-measurement in next.config.js found 42 — so hitting it means either a
#: genuinely broken deploy or someone filling the map on purpose, and in both
#: cases the already-recorded signatures are the valuable ones.
MAX_SIGNATURES = 500

#: Per-field truncation. A `script-sample` is the first ~40 chars of the
#: offending script by spec, but nothing stops a sender posting megabytes.
MAX_FIELD = 200

_lock = threading.Lock()
_reports: dict[tuple[str, str, str], dict[str, Any]] = {}
_overflow = 0
_total = 0


def _clip(value: Any) -> str:
    """Any JSON value as a short, safe string."""
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    # Collapse whitespace so a multi-line script sample stays one log line.
    return " ".join(text.split())[:MAX_FIELD]


def _path_only(uri: str) -> str:
    """The document's path, without scheme, host or query.

    The query is dropped on purpose: these URLs carry tickers and, on some
    routes, a token query parameter. A violation is identified by WHICH PAGE it
    happened on, and the path says that. Keeping the query would put
    credentials in an aggregate that an admin endpoint then serves back.
    """
    if not uri:
        return ""
    try:
        return urlsplit(uri).path[:MAX_FIELD] or "/"
    except Exception:
        return _clip(uri)


def _record(body: dict[str, Any]) -> None:
    """Fold one violation into the aggregate."""
    global _overflow, _total
    # The legacy and modern shapes use different key spellings for the same
    # fields; accept either rather than caring which browser sent it.
    directive = _clip(body.get("effective-directive")
                      or body.get("effectiveDirective")
                      or body.get("violated-directive")
                      or body.get("violatedDirective"))
    blocked = _clip(body.get("blocked-uri") or body.get("blockedURL")
                    or body.get("blockedURI"))
    document = _path_only(body.get("document-uri") or body.get("documentURL")
                          or body.get("documentURI") or "")
    if not (directive or blocked or document):
        return                      # nothing identifiable; not worth a slot

    key = (directive, blocked, document)
    now = time.time()
    with _lock:
        _total += 1
        rec = _reports.get(key)
        if rec is None:
            if len(_reports) >= MAX_SIGNATURES:
                _overflow += 1
                return
            _reports[key] = {
                "directive": directive, "blocked_uri": blocked,
                "document": document, "count": 1,
                "first_seen": now, "last_seen": now,
                "sample": _clip(body.get("script-sample")
                                or body.get("sample")),
                "disposition": _clip(body.get("disposition")),
            }
            # Logged ONCE per distinct signature, at the moment it first
            # appears. That is the useful signal and it cannot flood: the
            # thousandth copy of a known violation only bumps a counter.
            log.warning("CSP violation (new signature): %s blocked=%s on %s",
                        directive or "?", blocked or "?", document or "?")
        else:
            rec["count"] += 1
            rec["last_seen"] = now


def _bodies(payload: Any) -> list[dict[str, Any]]:
    """Every violation object in whatever shape arrived.

    Three live shapes, all seen in the wild:
      legacy  {"csp-report": {...}}                  (Chrome/Safari, report-uri)
      modern  [{"type": "csp-violation", "body": {}}] (Reporting API, report-to)
      bare    {...}                                   (some proxies unwrap it)
    """
    if isinstance(payload, dict):
        inner = payload.get("csp-report")
        if isinstance(inner, dict):
            return [inner]
        return [payload]
    if isinstance(payload, list):
        out = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            body = item.get("body")
            out.append(body if isinstance(body, dict) else item)
        return out
    return []


@router.post("/csp-report", include_in_schema=False)
async def csp_report(request: Request) -> Response:
    """Accept a CSP violation report. Always 204, whatever arrives.

    204 rather than 200 with a body: the browser discards the response either
    way, so a payload is bytes spent on nobody. And never a 4xx — a browser
    cannot act on it, so an error status here only shows up as noise in the
    proxy log.
    """
    try:
        payload = await request.json()
    except Exception:
        # Not JSON, or an empty body. Nothing to do, and nothing worth logging
        # — this endpoint is public, so a junk POST is an expected event.
        return Response(status_code=204)
    for body in _bodies(payload):
        try:
            _record(body)
        except Exception:
            log.debug("unparseable CSP report body", exc_info=True)
    return Response(status_code=204)


@router.get("/csp-report/summary")
def csp_summary(_: dict = Depends(require_master_admin)) -> dict[str, Any]:
    """What has been reported, most frequent first. Master-admin only.

    Gated because it describes the app's script surface — which inline scripts
    exist, which origins have been refused — and because `sample` can contain
    a fragment of whatever script was blocked. That is exactly the detail
    somebody probing for an injection point would like to read back.

    THIS IS THE ENFORCEMENT CHECKLIST. CSP_ENFORCE=1 is safe when every
    signature listed here is one that has since been hashed or allowed. Until
    then the list IS the reason it stays report-only, with counts instead of
    recollection.
    """
    with _lock:
        rows = sorted(_reports.values(), key=lambda r: -r["count"])
        return {
            "signatures": len(rows),
            "reports_received": _total,
            # Non-zero means the cap was hit and some signatures were never
            # recorded, so the list below is not exhaustive. Stated rather than
            # implied, because a silently truncated security report is worse
            # than a loud one.
            "dropped_over_cap": _overflow,
            "cap": MAX_SIGNATURES,
            "rows": rows,
        }


def reset_for_tests() -> None:
    """Clear the aggregate. Used by the tests; harmless in production."""
    global _overflow, _total
    with _lock:
        _reports.clear()
        _overflow = 0
        _total = 0
