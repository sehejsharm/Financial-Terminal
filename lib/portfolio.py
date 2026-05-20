"""Load and save user holdings to data/portfolio.json (gitignored)."""
from __future__ import annotations

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PORTFOLIO_PATH = DATA_DIR / "portfolio.json"


def load_portfolio() -> list[dict]:
    """Return the saved holdings list, or an empty list if none/invalid.

    Each holding: {ticker, shares, cost_basis}.
    """
    if not PORTFOLIO_PATH.exists():
        return []
    try:
        with open(PORTFOLIO_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            data = data.get("holdings", [])
        return [h for h in data if isinstance(h, dict) and h.get("ticker")]
    except Exception:
        return []


def save_portfolio(holdings: list[dict]) -> None:
    """Persist holdings to disk, creating the data directory if needed."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cleaned = []
    for h in holdings:
        ticker = str(h.get("ticker", "")).strip().upper()
        if not ticker:
            continue
        try:
            shares = float(h.get("shares", 0) or 0)
            cost = float(h.get("cost_basis", 0) or 0)
        except (TypeError, ValueError):
            continue
        cleaned.append({"ticker": ticker, "shares": shares, "cost_basis": cost})
    with open(PORTFOLIO_PATH, "w", encoding="utf-8") as fh:
        json.dump(cleaned, fh, indent=2)
