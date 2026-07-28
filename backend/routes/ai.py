"""AI endpoints — bull/bear, deep analysis."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from backend import auth
from backend.cache import cached
from pydantic import BaseModel, Field

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


# ── value-chain scenario simulator ────────────────────────────────────────

class ScenarioRequest(BaseModel):
    """'What happens to X if this supplier's output drops 20%?' — analysed
    against the company's actual mapped chain, not the ticker in isolation."""
    ticker: str = Field(..., max_length=24)
    company: str = Field(..., max_length=160)
    node_name: str = Field(..., max_length=160)
    node_role: str = Field(..., max_length=20)
    shock_pct: float = Field(..., ge=-100, le=500,
                             description="Change in the node's output/demand, e.g. -20")
    # The caller passes the chain it is actually showing, so the narrative is
    # grounded in the same numbers on screen rather than the model's memory.
    context: dict = Field(default_factory=dict)


_SCENARIO_PROMPT = """You are a supply-chain risk analyst working inside a
research terminal. Analyse ONE specific shock and walk the company's ACTUAL
mapped value chain.

SUBJECT: {company} ({ticker})
SHOCK: {node_name} (a {node_role} of the subject) sees its output/volume
change by {shock_pct:+.0f}%.

THE SUBJECT'S MAPPED CHAIN (the only relationship data you may rely on):
{chain}

Write a cascading analysis with these sections, in markdown:

## Direct impact
What this specifically does to {company} — reference the exposure percentage
from the chain data above if one is given, and say plainly if none is given.

## Second-order effects
Which OTHER nodes in the chain above are affected and how. Name them exactly
as they appear in the data. If a competitor benefits, say so.

## What would absorb it
Substitution, inventory, contracted pricing, alternative suppliers PRESENT IN
THE DATA ABOVE. If the chain shows no alternative supplier, say that is the
core risk.

## What to watch
Concrete observable signals — a disclosure, a price series, a volume figure.

HARD RULES:
- Use ONLY the relationships in the chain data above. Do NOT introduce
  companies that do not appear in it.
- The chain data is AI-ESTIMATED, not filing-sourced. Never state a
  percentage as fact; write "the map estimates ~X%".
- Do NOT invent financial figures (revenue, EBIT, contract values) that are
  not in the data above. Qualitative direction is fine; fabricated magnitudes
  are not.
- No investment recommendation. Educational analysis only.
- Be concise: roughly 250-350 words total.
"""


def _chain_for_prompt(context: dict) -> str:
    """Flatten the client's chain into compact, unambiguous prompt lines."""
    out = []
    for role in ("suppliers", "customers", "competitors"):
        for n in (context.get(role) or [])[:12]:
            name = (n or {}).get("name")
            if not name:
                continue
            bits = [f"- {role[:-1]}: {name}"]
            pct = n.get("revenue_pct")
            if pct is not None:
                unit = "of input costs" if role == "suppliers" else "of revenue"
                bits.append(f"(~{pct}% {unit}, AI-estimated)")
            if n.get("note"):
                bits.append(f"— {n['note']}")
            out.append(" ".join(bits))
    return "\n".join(out) or "(no relationships mapped)"


@router.post("/value-chain-scenario")
def value_chain_scenario(body: ScenarioRequest,
                         _user: dict = Depends(auth.current_user)):
    """Cascading what-if across the mapped chain."""
    _guard()
    prompt = _SCENARIO_PROMPT.format(
        company=body.company, ticker=body.ticker,
        node_name=body.node_name, node_role=body.node_role,
        shock_pct=body.shock_pct, chain=_chain_for_prompt(body.context),
    )
    try:
        text = ai_analyst._call(prompt, max_tokens=1200)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return {"ticker": body.ticker, "node": body.node_name,
            "shock_pct": body.shock_pct, "markdown": text}


# ── "Ask Motherboard" — retrieval across the user's own modules ────────────
#
# The point of this endpoint is what it REFUSES to do. It answers only from
# context assembled out of the caller's own data (their portfolio, their
# watchlists, the maps they've generated, the alerts they've set, live macro),
# and every block is labelled with the module it came from so the answer can
# cite a source the user can go and check. If the context doesn't contain the
# answer, the correct output is "I don't have that", not a plausible
# recollection from the model's training data.

class AskRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=500)
    # Ticker the user was looking at when they asked, so the answer can lead
    # with what's on screen rather than guessing at the subject.
    context_ticker: str | None = Field(None, max_length=24)


_ASK_PROMPT = """You are the research assistant inside a financial terminal.
Answer the user's question using ONLY the CONTEXT below, which was retrieved
from this specific user's own data a moment ago.

CONTEXT
=======
{context}
=======

QUESTION: {question}

HARD RULES — these matter more than being helpful:
- Answer ONLY from the context above. You have no other information about
  this user, their holdings, or current market levels.
- If the context does not contain what is needed, say exactly what is missing
  and which screen would have it. Do NOT fill the gap from memory: a
  confidently wrong position size or price is worse than "I don't have that".
- Cite the source module in brackets after facts you use, e.g. [Portfolio],
  [Macro], [Value chain: RELIANCE.NS]. Only cite blocks that actually appear
  above.
- Value-chain relationships are AI-ESTIMATED, not filing-sourced. If you use
  one, say so.
- Prices and portfolio values are a snapshot from when this question was
  asked, and can be delayed. Don't present them as live.
- No investment recommendations. Educational analysis only.
- Be brief: a few sentences or a short list. Markdown, no preamble.
"""


def _fmt_money(v, cur: str = "") -> str:
    try:
        return f"{cur}{float(v):,.0f}"
    except Exception:
        return "—"


def _ctx_portfolio(user: dict) -> str | None:
    """Positions, weights and P&L — the block most questions actually want."""
    try:
        from backend.routes.portfolio import summary as _summary
        s = _summary(None, user)
        positions = s.get("positions") or []
        if not positions:
            return None
        lines = []
        t = s.get("totals") or {}
        ccys = {p.get("currency") for p in positions if p.get("currency")}
        cur = next(iter(ccys)) if len(ccys) == 1 else ""
        lines.append(
            f"Total value {_fmt_money(t.get('value'))} {cur}, cost "
            f"{_fmt_money(t.get('cost'))}, unrealised P&L {_fmt_money(t.get('pnl'))} "
            f"({t.get('pnl_pct')}%)."
            + (" NOTE: mixed-currency book, so the total is a raw sum of different "
               "currencies and is not a meaningful single figure."
               if len(ccys) > 1 else ""))
        for p in sorted(positions, key=lambda x: -(x.get("value") or 0))[:25]:
            lines.append(
                f"- {p.get('ticker')} ({p.get('name') or '?'}): qty {p.get('qty')}, "
                f"value {_fmt_money(p.get('value'))} {p.get('currency') or ''}, "
                f"weight {p.get('weight')}%, P&L {p.get('pnl_pct')}%, "
                f"sector {p.get('sector') or 'unknown'}")
        for sec in (s.get("sectors") or [])[:8]:
            lines.append(f"- sector {sec.get('sector')}: {sec.get('weight')}% of book")
        return "\n".join(lines)
    except Exception:
        return None


def _ctx_watchlists(user: dict) -> str | None:
    try:
        from backend.routes.watchlists import list_all
        wls = list_all(user) or []
        out = []
        for w in wls[:10]:
            d = w if isinstance(w, dict) else w.model_dump()
            out.append(f"- {d.get('name')}: {', '.join((d.get('tickers') or [])[:30])}")
        return "\n".join(out) or None
    except Exception:
        return None


def _ctx_alerts(user: dict) -> str | None:
    try:
        from backend.routes.alerts import list_alerts
        # list_alerts returns the whole alerts document, not a bare list.
        doc = list_alerts(user) or {}
        rows = doc.get("alerts") or []
        active = [a for a in rows if a.get("active")]
        if not active:
            return None
        return "\n".join(
            f"- {a.get('ticker') or a.get('kind')} {a.get('op')} {a.get('value')}"
            f"{' (already triggered ' + str(a.get('triggered_at'))[:10] + ')' if a.get('triggered_at') else ''}"
            for a in active[:20])
    except Exception:
        return None


def _ctx_snapshot(ticker: str) -> str | None:
    """Live-ish figures for the name the user is looking at."""
    if not ticker:
        return None
    try:
        f = _normalize_units(get_stock_fundamentals(ticker) or {})
    except Exception:
        return None
    if not f:
        return None
    keep = ("name", "sector", "industry", "price", "market_cap", "pe_ratio",
            "forward_pe", "pb_ratio", "dividend_yield", "profit_margin", "roe",
            "debt_to_equity", "revenue", "revenue_growth", "beta", "currency",
            "fifty_two_week_high", "fifty_two_week_low")
    bits = [f"{k}: {f[k]}" for k in keep if f.get(k) not in (None, "")]
    return f"{ticker} — " + "; ".join(bits) if bits else None


def _ctx_value_chain(ticker: str) -> str | None:
    """The most recent generated map for this name, if one exists."""
    if not ticker:
        return None
    try:
        import json as _json
        from backend.routes.value_chain import HISTORY_PATH
        if not HISTORY_PATH.exists():
            return None
        latest = None
        with open(HISTORY_PATH, "r", encoding="utf-8") as fh:
            for ln in fh:
                try:
                    rec = _json.loads(ln)
                except Exception:
                    continue
                if str(rec.get("ticker", "")).upper() == ticker.upper():
                    latest = rec
        if not latest:
            return None
        data = latest.get("data") or {}
        out = [f"(AI-estimated map generated {str(latest.get('ts'))[:10]})"]
        for role in ("suppliers", "customers", "competitors"):
            names = [n.get("name") for n in (data.get(role) or []) if n.get("name")]
            if names:
                out.append(f"- {role}: {', '.join(names[:12])}")
        return "\n".join(out) if len(out) > 1 else None
    except Exception:
        return None


def _ctx_macro() -> str | None:
    """Latest Treasury curve. Cheap enough to include, and the 10y2y spread is
    the one macro number that comes up in questions about anything."""
    try:
        from lib import rates
        df = rates.get_yield_curve()
        if df is None or df.empty:
            return None
        pts = [f"{r['maturity']}: {float(r['yield']):.2f}%"
               for _, r in df.iterrows()]
        line = "US Treasury yield curve — " + ", ".join(pts)
        by = {r["maturity"]: float(r["yield"]) for _, r in df.iterrows()}
        if "10Y" in by and "2Y" in by:
            spread = by["10Y"] - by["2Y"]
            line += (f". 10y-2y spread {spread:+.2f}pp"
                     f" ({'inverted' if spread < 0 else 'positive'}).")
        return line
    except Exception:
        return None


def build_ask_context(user: dict, ticker: str | None) -> list[tuple[str, str]]:
    """Assemble labelled context blocks. Each is (module label, text).

    Every block is optional: a user with no portfolio simply has no Portfolio
    block, and the prompt's rules make the model say so rather than invent one.
    """
    t = (ticker or "").strip().upper()
    candidates = [
        ("Portfolio", _ctx_portfolio(user)),
        ("Watchlists", _ctx_watchlists(user)),
        ("Alerts", _ctx_alerts(user)),
        (f"Snapshot: {t}" if t else "Snapshot", _ctx_snapshot(t) if t else None),
        (f"Value chain: {t}" if t else "Value chain",
         _ctx_value_chain(t) if t else None),
        ("Macro", _ctx_macro()),
    ]
    return [(label, text) for label, text in candidates if text]


@router.post("/ask")
def ask(body: AskRequest, user: dict = Depends(auth.current_user)):
    """Answer a question from the user's own modules, or admit it can't."""
    _guard()
    blocks = build_ask_context(user, body.context_ticker)
    if not blocks:
        return {
            "question": body.question,
            "sources": [],
            "markdown": ("I have no data to answer from — there's no portfolio, "
                         "watchlist, alert or generated value-chain map on this "
                         "account yet, and no ticker in context. Add a position "
                         "or open a company in the Terminal, then ask again."),
        }
    context = "\n\n".join(f"[{label}]\n{text}" for label, text in blocks)
    try:
        text = ai_analyst._call(
            _ASK_PROMPT.format(context=context, question=body.question),
            max_tokens=900)
    except ai_analyst.AnalystError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return {"question": body.question,
            "sources": [label for label, _ in blocks],
            "markdown": text}
