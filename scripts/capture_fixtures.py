#!/usr/bin/env python3
"""Snapshot every provider's RAW response for the golden universe (Phase 0.1).

WHY THIS IS A SCRIPT AND NOT A TEST
-----------------------------------
The invariant suite must never touch the network — a test that calls Yahoo is a
test that fails on a bad afternoon and teaches the team to ignore red builds.
So capture is a deliberate, occasional act: run this once on a machine that can
reach the providers, commit the result, and every test from then on runs against
frozen bytes.

RUN IT ON A NETWORKED MACHINE:

    python scripts/capture_fixtures.py            # all providers, all tickers
    python scripts/capture_fixtures.py --only nse # one provider
    python scripts/capture_fixtures.py --symbols RELIANCE.NS,INFY.NS

It writes tests/fixtures/golden/raw/<provider>/<symbol>.json plus a manifest
recording when each snapshot was taken and which provider version produced it.

RAW means raw. No normalisation, no unit conversion, no key renaming. The whole
point of Phase 1 is that normalisation is a thing we can test, and you cannot
test a transform whose input has already been transformed.

Failures are recorded, not raised. A provider being down is itself a fact worth
freezing — `{"_error": "..."}` in a fixture is how the suite gets a regression
test for the degraded path (defect #56).
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "tests" / "fixtures" / "golden"
RAW = GOLDEN / "raw"

sys.path.insert(0, str(ROOT))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── provider probes ───────────────────────────────────────────────────────
#
# Each returns a plain dict/list straight from the provider. Keep these thin:
# the moment a probe starts "helping", the fixture stops representing reality.

def probe_nse_quote(symbol: str):
    from lib import nse
    return nse._get("/api/quote-equity", {"symbol": nse._clean_symbol(symbol)})


def probe_nse_results(symbol: str):
    from lib import nse
    return nse._get("/api/corporates-financial-results", {
        "index": "equities", "symbol": nse._clean_symbol(symbol),
        "period": "Quarterly"})


def probe_nse_corp_info(symbol: str):
    from lib import nse
    return nse._get("/api/quote-equity",
                    {"symbol": nse._clean_symbol(symbol), "section": "corp_info"})


def probe_yfinance_info(symbol: str):
    import yfinance as yf
    return dict(yf.Ticker(symbol).info or {})


def probe_yfinance_history(symbol: str):
    import yfinance as yf
    df = yf.Ticker(symbol).history(period="2y", interval="1d", auto_adjust=False)
    if df is None or df.empty:
        return {"_error": "empty history"}
    # Records, not a pickled frame: a fixture you cannot read in a diff is a
    # fixture nobody will ever check.
    df = df.reset_index()
    df.columns = [str(c) for c in df.columns]
    return json.loads(df.to_json(orient="records", date_format="iso"))


def probe_fmp_profile(symbol: str):
    from backend import providers
    if not providers.has_fmp():
        return {"_error": "FMP_API_KEY not configured"}
    return providers.fmp_capital(symbol)


def probe_twelve_quote(symbol: str):
    from backend import providers
    fn = getattr(providers, "twelve_quote", None)
    if fn is None:
        return {"_error": "no twelve_data adapter exposed"}
    return fn(symbol)


PROBES = {
    "nse_quote": probe_nse_quote,
    "nse_results": probe_nse_results,
    "nse_corp_info": probe_nse_corp_info,
    "yfinance_info": probe_yfinance_info,
    "yfinance_history": probe_yfinance_history,
    "fmp_profile": probe_fmp_profile,
    "twelve_quote": probe_twelve_quote,
}

# Indices have no fundamentals and no shareholding; probing them produces
# noise, not coverage.
SKIP_FOR_INDEX = {"nse_results", "nse_corp_info", "fmp_profile"}


def load_universe() -> list[dict]:
    return json.loads((GOLDEN / "universe.json").read_text())["tickers"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated probe names")
    ap.add_argument("--symbols", help="comma-separated symbols")
    args = ap.parse_args()

    probes = ({p: PROBES[p] for p in args.only.split(",")} if args.only
              else dict(PROBES))
    unknown = set(probes) - set(PROBES)
    if unknown:
        print(f"unknown probe(s): {sorted(unknown)}", file=sys.stderr)
        return 2

    universe = load_universe()
    if args.symbols:
        want = {s.strip().upper() for s in args.symbols.split(",")}
        universe = [t for t in universe if t["symbol"].upper() in want]

    manifest: dict = {"captured_at": _now(), "entries": {}}
    ok = failed = skipped = 0

    for entry in universe:
        symbol = entry["symbol"]
        is_index = entry.get("entity_type") == "index"
        for name, fn in probes.items():
            if is_index and name in SKIP_FOR_INDEX:
                skipped += 1
                continue
            out_dir = RAW / name
            out_dir.mkdir(parents=True, exist_ok=True)
            path = out_dir / f"{symbol.replace('^', '_idx_')}.json"
            try:
                payload = fn(symbol)
                status = "empty" if payload in (None, {}, []) else "ok"
            except Exception as exc:                      # noqa: BLE001
                payload = {"_error": f"{type(exc).__name__}: {exc}",
                           "_traceback": traceback.format_exc(limit=3)}
                status = "error"
            path.write_text(json.dumps(payload, indent=2, default=str))
            manifest["entries"][f"{name}/{symbol}"] = {
                "status": status, "captured_at": _now(),
                "path": str(path.relative_to(ROOT)),
            }
            if status == "ok":
                ok += 1
            else:
                failed += 1
            print(f"  {status:5}  {name:18} {symbol}")

    (GOLDEN / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\ncaptured: {ok} ok, {failed} empty/error, {skipped} skipped")
    print(f"manifest: {GOLDEN / 'manifest.json'}")
    # Deliberately exits 0 even with failures: a provider outage is data, and
    # this script's job is to record what happened, not to gate on it.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
