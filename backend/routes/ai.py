"""AI endpoints — bull/bear, deep analysis."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from backend import auth
from backend.cache import cached
from backend.schemas import AIRequest
from lib import ai_analyst
from lib.market_data import get_stock_fundamentals

router = APIRouter(prefix="/ai", tags=["ai"])


def _guard():
    if not ai_analyst.is_available():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "No AI provider configured (GROQ_API_KEY or "
                            "GEMINI_API_KEY)")


# Fields stored as decimal fractions (0.0998 == 9.98%) and fields holding
# raw magnitudes that read as digit soup in prose ("17768137097216 INR").
_FRACTION_FIELDS = {
    "dividend_yield", "profit_margin", "operating_margin", "gross_margin",
    "roe", "roa", "roce", "revenue_growth", "earnings_growth",
    "held_insiders", "held_institutions",
}
_MAGNITUDE_FIELDS = {
    "market_cap", "revenue", "ebitda", "free_cashflow", "shares_outstanding",
    "volume", "avg_volume", "enterprise_value", "total_debt", "total_cash",
}

_CCY_SIGNS = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}


def _human_magnitude(v: float, sign: str) -> str:
    """17768137097216 → '₹17.77T' — mirrors the UI's humanNumber()."""
    a = abs(v)
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= div:
            return f"{sign}{v / div:.2f}{suf}"
    return f"{sign}{v:,.0f}"


def _normalize_units(f: dict) -> dict:
    """Format fundamentals into the same human-readable forms the UI shows
    BEFORE they reach the LLM prompt — otherwise the narrative parrots raw
    values like '17768137097216 INR' or '0.099750005' instead of '₹17.77T'
    and '9.98%'. Also converts provider quirk units (yfinance's percent-
    scaled debt/equity → 0.37x ratio)."""
    f = dict(f)
    de = f.get("debt_to_equity")
    if isinstance(de, (int, float)):
        f["debt_to_equity"] = f"{de / 100:.2f}x"
    sign = _CCY_SIGNS.get(str(f.get("currency") or ""), "")
    for k, v in list(f.items()):
        if not isinstance(v, (int, float)):
            continue
        if k in _FRACTION_FIELDS:
            f[k] = f"{v * 100:.2f}%"
        elif k in _MAGNITUDE_FIELDS:
            # Share/volume counts aren't currency amounts.
            unit_sign = "" if k in ("shares_outstanding", "volume", "avg_volume") else sign
            f[k] = _human_magnitude(float(v), unit_sign)
        elif abs(v) < 1000:
            f[k] = round(float(v), 2)
    return f


@router.get("/provider")
def provider(_user: dict = Depends(auth.current_user)):
    return {"available": ai_analyst.is_available(),
            "provider": ai_analyst.active_provider()}


@router.post("/bull-bear")
def bull_bear(body: AIRequest, _user: dict = Depends(auth.current_user)):
    _guard()
    f = _normalize_units(get_stock_fundamentals(body.ticker) or {})
    try:
        text = ai_analyst.bull_bear_case(body.ticker, f, None)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return {"ticker": body.ticker, "markdown": text}


@router.post("/deep-analysis")
def deep(body: AIRequest, _user: dict = Depends(auth.current_user)):
    _guard()
    f = _normalize_units(get_stock_fundamentals(body.ticker) or {})
    try:
        text = ai_analyst.deep_analysis(body.ticker, f, None)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return {"ticker": body.ticker, "markdown": text}


# ── news sentiment ───────────────────────────────────────────────────────

_SENT_PROMPT = (
    "Classify the market sentiment of each numbered headline about {ticker} "
    "as exactly one of: bull, bear, neutral. Return ONLY a JSON array of "
    "strings in the same order, e.g. [\"bull\",\"neutral\",\"bear\"]. "
    "No prose.\n\n{headlines}"
)


def parse_sentiment_labels(raw: str, n: int) -> list[str] | None:
    """Extract the JSON label array from an LLM response; None on mismatch."""
    import json as _json
    import re as _re
    m = _re.search(r"\[.*\]", raw, _re.DOTALL)
    if not m:
        return None
    try:
        labels = _json.loads(m.group())
    except Exception:
        return None
    if not isinstance(labels, list) or len(labels) != n:
        return None
    out = []
    for x in labels:
        s = str(x).strip().lower()
        out.append(s if s in ("bull", "bear", "neutral") else "neutral")
    return out


@cached(ttl=1800)
def _classify_headlines(ticker: str, headlines: tuple[str, ...]) -> list[str] | None:
    numbered = "\n".join(f"{i + 1}. {h}" for i, h in enumerate(headlines))
    try:
        raw = ai_analyst._call(
            _SENT_PROMPT.format(ticker=ticker, headlines=numbered),
            max_tokens=300)
    except ai_analyst.AnalystError:
        return None
    return parse_sentiment_labels(raw, len(headlines))


def _append_sentiment_history(ticker: str, score: float, n: int) -> None:
    import json as _json
    from datetime import datetime, timezone
    from lib.auth import DATA_DIR
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(DATA_DIR / "sentiment.jsonl", "a", encoding="utf-8") as fh:
            fh.write(_json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "ticker": ticker.upper(), "score": round(score, 3), "n": n,
            }) + "\n")
    except Exception:
        pass


@router.post("/sentiment")
def sentiment(body: AIRequest, _user: dict = Depends(auth.current_user)):
    """Tag each recent headline bull/bear/neutral (one Groq call, cached 30m)
    and roll up a [-1, 1] score. Each rollup is appended to a history log so
    a per-ticker sentiment trend accumulates over time."""
    _guard()
    from lib import news as news_mod
    from backend.routes.market import _strip_html
    items = news_mod.ticker_news(body.ticker, limit=12)
    heads = tuple(_strip_html(i.get("title") or "") for i in items if i.get("title"))
    if not heads:
        return {"ticker": body.ticker, "items": [], "score": None, "history": []}
    labels = _classify_headlines(body.ticker.upper(), heads)
    if labels is None:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            "Sentiment classification failed — try again.")
    score = (labels.count("bull") - labels.count("bear")) / len(labels)
    _append_sentiment_history(body.ticker, score, len(labels))
    return {
        "ticker": body.ticker,
        "items": [{"title": h, "sentiment": s} for h, s in zip(heads, labels)],
        "score": score,
        "history": _sentiment_history(body.ticker),
    }


def _sentiment_history(ticker: str, limit: int = 60) -> list[dict]:
    import json as _json
    from lib.auth import DATA_DIR
    path = DATA_DIR / "sentiment.jsonl"
    if not path.exists():
        return []
    out = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for ln in fh:
                try:
                    rec = _json.loads(ln)
                except Exception:
                    continue
                if rec.get("ticker") == ticker.upper():
                    out.append(rec)
    except Exception:
        return []
    return out[-limit:]
