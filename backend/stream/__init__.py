"""Real-time market-data streaming: coalesced ingest → in-process hub →
WebSocket/SSE fan-out. One poll per symbol per interval regardless of how
many clients want it."""
