"""Real-time streaming endpoints: multiplexed WebSocket (primary) + SSE
(fallback for networks that block WS). Both speak the same frames.

Contract (see docs / the plan):
  Client → server (WS only): {"op":"sub"|"unsub","symbols":[...]} / {"op":"ping"}
  Server → client: {"t":"snap"|"px"|"hb"|"stat"|"err", ...}

Auth: ?token=<jwt> query param (WS/SSE can't set an Authorization header).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from backend import auth
from backend.stream import hub, ingest, session

log = logging.getLogger("motherboard.stream")
router = APIRouter(tags=["stream"])

_HB_SEC = 10          # heartbeat cadence
_MAX_SYMBOLS = 60     # per-connection subscription cap


def _stat_frame() -> dict:
    return {"t": "stat", "ts": int(time.time() * 1000),
            "d": {"marketOpen": session.any_market_open(),
                  "nseOpen": session.is_open("NSE"),
                  "usOpen": session.is_open("US")}}


@router.websocket("/stream")
async def stream_ws(ws: WebSocket, token: str | None = Query(None)):
    if auth.decode_token(token) is None:
        await ws.close(code=4401)  # unauthenticated
        return
    await ws.accept()
    conn = hub.Connection()
    hub.register(conn)

    async def _send_loop() -> None:
        await ws.send_text(json.dumps(_stat_frame()))
        while conn.alive:
            try:
                frame = await asyncio.wait_for(conn.queue.get(), timeout=_HB_SEC)
                await ws.send_text(json.dumps(frame))
            except asyncio.TimeoutError:
                # Heartbeat doubles as a market-state refresh: a bare hb would
                # freeze the client's marketOpen for the whole connection, so
                # an NSE→closed transition would never reach an idle client.
                await ws.send_text(json.dumps(_stat_frame()))

    send_task = asyncio.create_task(_send_loop())
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            op = msg.get("op")
            if op == "sub":
                wanted = [s for s in (msg.get("symbols") or []) if isinstance(s, str)]
                room = _MAX_SYMBOLS - len(conn.symbols)
                snap = hub.add_symbols(conn, wanted[:max(0, room)])
                if snap:
                    conn._enqueue({"t": "snap", "d": snap})
            elif op == "unsub":
                hub.remove_symbols(conn, [s for s in (msg.get("symbols") or [])
                                         if isinstance(s, str)])
            elif op == "ping":
                conn._enqueue({"t": "hb", "ts": int(time.time() * 1000)})
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("stream ws error")
    finally:
        send_task.cancel()
        hub.unregister(conn)


@router.get("/stream/sse")
async def stream_sse(request: Request, symbols: str = Query(""),
                     token: str | None = Query(None)):
    """SSE fallback. Subscriptions are fixed at connect time (query param);
    reconnect with a new ?symbols= to change them."""
    if auth.decode_token(token) is None:
        return StreamingResponse(iter(()), status_code=401)
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()][:_MAX_SYMBOLS]
    conn = hub.Connection()

    async def _gen():
        # Register INSIDE the generator so registration and the finally's
        # unregister are on the same execution path — if the client vanishes
        # before iteration starts, neither happens (balanced, no leak).
        hub.register(conn)
        snap = hub.add_symbols(conn, syms)
        try:
            yield f"data: {json.dumps(_stat_frame())}\n\n"
            if snap:
                yield f"data: {json.dumps({'t': 'snap', 'd': snap})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(conn.queue.get(), timeout=_HB_SEC)
                    yield f"data: {json.dumps(frame)}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps(_stat_frame())}\n\n"
        finally:
            hub.unregister(conn)

    return StreamingResponse(_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@router.get("/stream/health")
def stream_health():
    """Observability for the /admin panel: sockets, symbols, feed latency."""
    return {**hub.stats(), **ingest.metrics(),
            "marketOpen": session.any_market_open()}
