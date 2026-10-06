"""Complaint intake, with a reference number and a durable record.

A grievance mechanism that is only an email address has two problems: the user
has no evidence they complained, and we have no record we can be held to. Both
matter if a complaint is ever escalated to SEBI's SCORES platform, where the
first question is what we did and when.

So a complaint produces a reference, is written to disk before anything else
can fail, and is then emailed onward. The order is deliberate — see below.

UNAUTHENTICATED ON PURPOSE. The people most likely to need this are the ones
who cannot get in: a failed invite, a password reset that never arrived, an
account that was deactivated. Requiring a login to report that you cannot log
in is a complaint channel that excludes exactly the complaints it exists for.
It is rate-limited tightly instead.
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from backend import mailer, ratelimit
from lib.atomic import read_json_resilient, write_json_atomic

log = logging.getLogger("motherboard.support")

router = APIRouter(prefix="/support", tags=["support"])

# Long enough that a reference cannot be guessed to read someone else's
# complaint, short enough to read over the phone.
_REF_BYTES = 5

_lock = threading.Lock()
_path: Path | None = None


def configure(data_dir: Path) -> None:
    global _path
    with _lock:
        _path = Path(data_dir) / "grievances.json"


class GrievanceRequest(BaseModel):
    # Bounded so this cannot be used to write arbitrary volumes to the data
    # volume. The body limit middleware also caps the request, but a field cap
    # gives the user a clear message instead of a 413.
    body: str = Field(min_length=10, max_length=5000)
    email: str = Field(min_length=3, max_length=320)


def _store(record: dict[str, Any]) -> None:
    assert _path is not None
    data = read_json_resilient(_path, {"grievances": []})
    if not isinstance(data, dict) or "grievances" not in data:
        data = {"grievances": []}
    data["grievances"].append(record)
    _path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(_path, data)


@router.post("/grievance")
def file_grievance(body: GrievanceRequest, request: Request):
    """Record a complaint and return its reference."""
    if "@" not in body.email:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That does not look like an email address.")
    reference = "MB-" + secrets.token_hex(_REF_BYTES).upper()
    record = {
        "reference": reference,
        "ts": time.time(),
        "email": body.email.strip(),
        "body": body.body.strip(),
        # For abuse investigation only. The real client address, not the
        # proxy's — see backend/ratelimit.client_ip.
        "ip": ratelimit.client_ip(request),
        "status": "open",
    }

    # WRITTEN BEFORE IT IS SENT, and the order is the point: if the mail
    # provider is down, the complaint still exists and still has a reference
    # we can be held to. Emailing first and storing second would mean an
    # outage loses the record while the user holds a reference for something
    # we have no trace of.
    with _lock:
        try:
            _store(record)
        except Exception:
            log.exception("could not persist grievance %s", reference)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Could not record your complaint. Email us directly — do not "
                "rely on this form having worked.",
            )

    try:
        mailer.send(
            body.email.strip(),
            f"We received your complaint ({reference})",
            f"""We have recorded your complaint. Your reference is {reference}.

Keep this reference. We will reply within 7 working days.

If we do not reply in that time, or you are not satisfied with the reply, you
can escalate to SEBI through the SCORES platform at https://scores.sebi.gov.in
without needing our permission.

What you told us:

{body.body.strip()}
""",
        )
    except mailer.MailError:
        # Logged, not surfaced. The complaint IS recorded, which is what the
        # user needs; failing the request here would tell them it did not work
        # when it did, and would invite them to file it again.
        log.exception("grievance %s stored but acknowledgement not sent",
                      reference)

    log.warning("grievance filed: %s from %s", reference, body.email)
    return {"ok": True, "reference": reference}
