"""The seam a licensed real-time feed drops into.

NO VENDOR IS IMPLEMENTED HERE, and that is on instruction: the adapters wait
until the contract is signed, because the shape of one depends entirely on
which. A FIX session, a websocket pushing binary frames, and a REST endpoint
polled on a licence-limited quota are three different programs, and the one
thing they share is this interface.

What a vendor module has to provide is below. When the contract exists, the
work is: one file in this package, one line in `_REGISTRY`, and the
REALTIME_FEED env var. Nothing at any call site changes, because everything
upstream talks to `active()` and to `dataplane`.

WHY THE DEFAULT IS None RATHER THAN A STUB

`active()` returning None means "there is no licensed feed", and every caller
already handles that: quotes come from the existing public providers and are
labelled PUBLIC. A stub feed that returned fake ticks, or raised, would be a
thing the rest of the system had to be taught to distinguish from a real one —
and the distinction would be load-bearing for a licensing rule. Absent is
safer than pretend.
"""
from __future__ import annotations

import logging
import os
from typing import Protocol, runtime_checkable

from backend.dataplane import LICENSED

log = logging.getLogger("motherboard.feeds")


@runtime_checkable
class RealtimeFeed(Protocol):
    """What a licensed feed adapter must offer.

    Deliberately small. Everything the app needs from a feed is "tell me the
    current price of these symbols, and tell me when you knew it" — the rest
    (reconnects, heartbeats, sequence gaps, the vendor's own symbology) is the
    adapter's problem and must not leak upward, or every vendor change becomes
    a change to the stream.
    """

    #: Shown in /diag and in the UI's source label.
    name: str

    def start(self, symbols: list[str]) -> None:
        """Begin receiving. Called once with the initial subscription set."""

    def subscribe(self, symbols: list[str]) -> None:
        """Add symbols to the live subscription."""

    def unsubscribe(self, symbols: list[str]) -> None:
        """Drop symbols. Licences are usually priced per concurrent symbol, so
        this is a cost control and not just tidiness."""

    def latest(self, symbol: str) -> dict | None:
        """The most recent tick, or None if nothing has arrived yet.

        MUST include an `as_of` in epoch seconds taken from the FEED's own
        timestamp, not from the local clock. The delayed plane releases on
        that value, so a local-clock substitute would silently shorten the
        delay — which is the licence breach this whole module exists to
        prevent.
        """

    def stop(self) -> None:
        """Disconnect and release the subscription."""


# Vendor adapters, by the value of REALTIME_FEED. Empty on purpose.
#
# To add one, e.g. after signing with a provider:
#     from backend.feeds import somevendor
#     _REGISTRY = {"somevendor": somevendor.Feed}
_REGISTRY: dict[str, type] = {}

#: The source class every adapter here produces. A feed under contract is
#: licensed by definition; an adapter wrapping a public endpoint does not
#: belong in this package, it belongs in backend/providers.py.
SOURCE_CLASS = LICENSED

_active: RealtimeFeed | None = None
_resolved = False


def configured_name() -> str:
    return (os.getenv("REALTIME_FEED") or "").strip().lower()


def available() -> list[str]:
    return sorted(_REGISTRY)


def active() -> RealtimeFeed | None:
    """The live feed, or None when there is no licensed feed configured.

    An unknown REALTIME_FEED value logs loudly and resolves to None rather
    than raising. The reasoning is specific to what this gates: failing to
    boot would take the whole product down, while returning None degrades to
    public data — which is exactly what the app did before any of this
    existed, and is never a licensing breach. The loud log is how someone
    finds out they typed the name wrong.
    """
    global _active, _resolved
    if _resolved:
        return _active
    _resolved = True
    name = configured_name()
    if not name:
        return None
    impl = _REGISTRY.get(name)
    if impl is None:
        log.error(
            "REALTIME_FEED=%r is not a known feed (have: %s). Falling back to "
            "public data for ALL tiers — paid accounts will see 'Public data' "
            "rather than live prices until this is fixed.",
            name, ", ".join(available()) or "none",
        )
        return None
    _active = impl()
    log.info("licensed real-time feed active: %s", _active.name)
    return _active


def reset_for_tests() -> None:
    """Forget the resolved feed so a test can change the environment."""
    global _active, _resolved
    _active, _resolved = None, False
