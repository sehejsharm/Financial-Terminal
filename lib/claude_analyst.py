"""Anthropic Claude API calls for educational market analysis.

Compliance: every prompt instructs the model to stay educational and to avoid
buy/sell/hold recommendations or personalized advice. The system prompt is
marked for prompt caching since it is reused across calls.
"""
from __future__ import annotations

import json

import streamlit as st

from lib.config import get_anthropic_key

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 1400

SYSTEM_PROMPT = (
    "You are an educational markets analyst for a personal-research dashboard. "
    "Your audience is studying how to think about companies and markets. "
    "Rules you must always follow:\n"
    "- Do NOT give buy, sell, or hold recommendations.\n"
    "- Do NOT state price targets as advice or predict exact prices.\n"
    "- Do NOT give personalized financial advice.\n"
    "- Present balanced, factual, educational analysis citing the data given.\n"
    "- Use neutral, descriptive language and note uncertainty.\n"
    "- Always remind the reader this is educational, not financial advice.\n"
    "Format responses in clean Markdown with short sections and bullet points."
)


class AnalystError(RuntimeError):
    pass


@st.cache_resource(show_spinner=False)
def _client():
    key = get_anthropic_key()
    if not key:
        return None
    try:
        import anthropic
        return anthropic.Anthropic(api_key=key)
    except Exception as exc:  # pragma: no cover - import/config errors
        raise AnalystError(f"Could not initialize Anthropic client: {exc}")


def is_available() -> bool:
    return get_anthropic_key() is not None


def _call(user_prompt: str, max_tokens: int = MAX_TOKENS) -> str:
    client = _client()
    if client is None:
        raise AnalystError("Anthropic API key is not configured.")
    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=[{
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception as exc:
        raise AnalystError(str(exc))
    parts = [b.text for b in resp.content if getattr(b, "type", None) == "text"]
    return "\n".join(parts).strip()


def _fmt(d: dict) -> str:
    """Compact JSON of non-null fields for prompting."""
    return json.dumps({k: v for k, v in d.items() if v is not None}, default=str)


def bull_bear_case(ticker: str, fundamentals: dict, technical: dict | None = None) -> str:
    prompt = (
        f"Provide an educational, balanced bull case and bear case for {ticker}.\n\n"
        f"Fundamental data: {_fmt(fundamentals)}\n"
        f"Technical context: {_fmt(technical or {})}\n\n"
        "Write two sections: '## Bull case' and '## Bear case', each with 3-5 "
        "concise bullet points grounded in the data above. Then a one-line "
        "'## Balance' summarizing the key tension. Do not recommend any action."
    )
    return _call(prompt)


def deep_analysis(ticker: str, fundamentals: dict, technical: dict | None = None) -> str:
    prompt = (
        f"Write an educational deep-dive on {ticker} for someone learning to "
        "analyze companies.\n\n"
        f"Fundamental data: {_fmt(fundamentals)}\n"
        f"Technical context: {_fmt(technical or {})}\n\n"
        "Cover: the business model, what the valuation multiples imply, "
        "profitability and balance-sheet quality, growth trajectory, and key "
        "risks/uncertainties to watch. Use clear sections. Explain the 'why' "
        "behind each metric so the reader learns. No recommendations."
    )
    return _call(prompt, max_tokens=2000)


def macro_pulse_check(indicators: list[dict], yield_curve_note: str = "") -> str:
    data = _fmt({"indicators": indicators, "yield_curve": yield_curve_note})
    prompt = (
        "Given these latest US macroeconomic indicators, write an educational "
        "'macro pulse-check' explaining what the current readings suggest about "
        "the economy's state (growth, inflation, labor, rates).\n\n"
        f"Data: {data}\n\n"
        "Structure: '## Where things stand', '## Cross-currents', "
        "'## What to watch'. Explain how the indicators relate to each other. "
        "Educational only; no market-timing or investment advice."
    )
    return _call(prompt)


def portfolio_analysis(summary: dict) -> str:
    prompt = (
        "Provide an educational review of this personal portfolio's "
        "characteristics (diversification, concentration, sector tilts, risk "
        "profile). Help the reader understand the composition.\n\n"
        f"Portfolio summary: {_fmt(summary)}\n\n"
        "Structure: '## Composition', '## Concentration & diversification', "
        "'## Risk characteristics', '## Questions to consider'. Frame the last "
        "section as educational questions, not advice. No buy/sell guidance."
    )
    return _call(prompt, max_tokens=1800)
