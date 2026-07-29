"""Deadlines, bounded concurrency, retries, and slow-request telemetry.

Three failures reported from production motivated this, and they share one
cause: a single-worker FastAPI process on a 1-vCPU / 768MB VM, with sync
endpoints that make slow third-party calls.

  * /api/v1/value-chain/{ticker} returning 502 — the browser sees "Network
    error" because the reverse proxy could not get an answer at all.
  * Macro → Sectors spinning forever with no timeout and no error state.
  * quote-bulk taking 5–9 seconds.

Starlette runs every `def` (non-async) endpoint in AnyIO's worker thread
pool, which defaults to 40 threads. Forty concurrent yfinance/pandas calls
on this box is both more CPU than exists and more memory than the container
is allowed, so the process gets OOM-killed and restarts — and every request
in flight during that window is a 502. Bounding the pool is what stops it.

Nothing here makes a slow provider fast. What it does is guarantee that a
slow provider produces a bounded, labelled, retryable failure instead of an
unbounded wait that takes the whole process down with it.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections import deque
from typing import Callable, TypeVar

from starlette.responses import JSONResponse
from starlette.types import ASGIApp

log = logging.getLogger("motherboard.reliability")

T = TypeVar("T")


# ── bounded worker threads ──────────────────────────────────────────────

def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, "")))
    except (TypeError, ValueError):
        return default


#: How many sync endpoint handlers may run at once. The default of 40 is
#: sized for a machine that isn't this one.
THREAD_LIMIT = _env_int("MB_THREAD_LIMIT", 12)


def configure_thread_pool(limit: int | None = None) -> int:
    """Clamp AnyIO's worker-thread pool. Returns the value applied.

    Queuing beyond the limit is the point: work waits its turn instead of
    all of it running badly at once and taking the box out.
    """
    n = limit or THREAD_LIMIT
    try:
        import anyio.to_thread
        anyio.to_thread.current_default_thread_limiter().total_tokens = n
    except Exception:  # pragma: no cover - anyio always present in practice
        log.warning("could not set thread limiter", exc_info=True)
        return 0
    return n


# ── slow-request telemetry ──────────────────────────────────────────────

#: Requests slower than this are recorded. Not an error — a data point.
SLOW_MS = _env_int("MB_SLOW_MS", 2_000)

_lock = threading.Lock()
_slow: deque[dict] = deque(maxlen=200)
_counts: dict[str, dict] = {}


def _bucket(path: str) -> str:
    """Collapse ids out of a path so /news/TCS.NS and /news/INFY.NS are one
    line in the report rather than two hundred."""
    parts = [p for p in path.split("/") if p]
    out = []
    for p in parts:
        out.append(p if (p.islower() and not p.replace(".", "").isdigit())
                   else "{id}")
    return "/" + "/".join(out)


def record(path: str, method: str, ms: float, status: int) -> None:
    key = f"{method} {_bucket(path)}"
    with _lock:
        c = _counts.setdefault(key, {"n": 0, "slow": 0, "timeouts": 0,
                                     "worst_ms": 0.0, "total_ms": 0.0})
        c["n"] += 1
        c["total_ms"] += ms
        c["worst_ms"] = max(c["worst_ms"], ms)
        if status == 504:
            c["timeouts"] += 1
        if ms >= SLOW_MS or status == 504:
            c["slow"] += 1
            _slow.append({"path": path, "method": method,
                          "ms": round(ms, 1), "status": status,
                          "at": time.time()})


def slow_report(limit: int = 40) -> dict:
    """What is slow, and what has timed out.

    Exposed on the admin page so a hang like the Sectors tab is visible as a
    number rather than as a user noticing a spinner that never stops.
    """
    with _lock:
        routes = [
            {"route": k, "calls": v["n"],
             "avg_ms": round(v["total_ms"] / v["n"], 1) if v["n"] else 0,
             "worst_ms": round(v["worst_ms"], 1),
             "slow": v["slow"], "timeouts": v["timeouts"]}
            for k, v in _counts.items()
        ]
        recent = list(_slow)[-limit:][::-1]
    routes.sort(key=lambda r: (-r["timeouts"], -r["worst_ms"]))
    return {
        "slow_threshold_ms": SLOW_MS,
        "deadline_s": REQUEST_DEADLINE_S,
        "thread_limit": THREAD_LIMIT,
        "routes": routes[:limit],
        "recent": recent,
        "note": ("A request is 'slow' past the threshold above and a "
                 "'timeout' when it hit the deadline and returned 504. "
                 "Timeouts are the ones to act on: they are requests a user "
                 "watched fail."),
    }


def reset_report() -> None:
    with _lock:
        _slow.clear()
        _counts.clear()


# ── request deadline ────────────────────────────────────────────────────

REQUEST_DEADLINE_S = float(os.getenv("MB_REQUEST_DEADLINE_S") or 55)

#: Paths that legitimately outlive the deadline. Streams are long-lived by
#: design; killing them at 55s would break the whole live-quote path.
DEADLINE_EXEMPT = ("/api/v1/stream", "/healthz", "/docs", "/openapi.json")


class DeadlineMiddleware:
    """Every request finishes, one way or another.

    Without this a slow upstream keeps a worker thread and a proxy
    connection occupied until something else gives up first — which is how a
    slow value-chain call became a 502 in the browser with no useful text.
    A 504 with a sentence explaining what happened is strictly better: the
    UI can show it, and the user can retry.

    Written as raw ASGI, not BaseHTTPMiddleware, and that is not a style
    preference. BaseHTTPMiddleware runs the downstream app inside a task
    group it awaits before returning, so cancelling `call_next` on a timeout
    does NOT release the client — a test asserting the request came back
    quickly caught this: the 504 was produced at 300ms and the caller still
    waited the full 30 seconds. Racing the downstream task directly and
    sending our own response is what actually unblocks the connection.

    The abandoned task is cancelled but a sync handler already inside a
    worker thread cannot be interrupted; it finishes on its own. That is
    acceptable and bounded — every provider call underneath has its own
    timeout — and the client is no longer waiting on it either way.
    """

    def __init__(self, app: ASGIApp, seconds: float | None = None):
        self.app = app
        self.seconds = seconds or REQUEST_DEADLINE_S

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        if any(path.startswith(p) for p in DEADLINE_EXEMPT):
            return await self.app(scope, receive, send)

        t0 = time.perf_counter()
        started = False
        status = 500

        async def send_wrapper(message):
            nonlocal started, status
            if message["type"] == "http.response.start":
                started = True
                status = message["status"]
            await send(message)

        task = asyncio.ensure_future(self.app(scope, receive, send_wrapper))
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=self.seconds)
        except (asyncio.TimeoutError, TimeoutError):
            ms = (time.perf_counter() - t0) * 1000
            record(path, method, ms, 504)
            log.warning("deadline exceeded: %s %s after %.0fms", method, path, ms)
            task.cancel()
            # Never swallow the cancellation error into the event loop's
            # "exception was never retrieved" warning stream.
            task.add_done_callback(lambda t: t.cancelled() or t.exception())
            if not started:
                await JSONResponse(
                    status_code=504,
                    content={"detail":
                             f"The server gave up on this request after "
                             f"{int(self.seconds)}s. The upstream data "
                             f"provider is slow or unreachable right now — "
                             f"this is a server-side problem, not your "
                             f"connection. Retry in a moment."},
                )(scope, receive, send)
            return
        record(path, method, (time.perf_counter() - t0) * 1000, status)


# ── retries ─────────────────────────────────────────────────────────────

def retry(fn: Callable[[], T], attempts: int = 3, base: float = 0.4,
          label: str = "") -> T:
    """Call fn, retrying transient failures with exponential backoff.

    Re-raises the LAST exception rather than a wrapper, so callers still see
    what actually went wrong. Backoff is 0.4s, 0.8s by default: long enough
    to ride out a provider blip, short enough to stay inside a request
    deadline.

    Not for use around anything non-idempotent. Everything it wraps here is
    a GET against a market-data provider.
    """
    last: Exception | None = None
    for i in range(max(1, attempts)):
        try:
            return fn()
        except Exception as exc:            # noqa: BLE001 - re-raised below
            last = exc
            if i == attempts - 1:
                break
            wait = base * (2 ** i)
            log.info("retry %s/%s%s after %s (%.1fs)",
                     i + 1, attempts, f" [{label}]" if label else "",
                     type(exc).__name__, wait)
            time.sleep(wait)
    assert last is not None
    raise last
