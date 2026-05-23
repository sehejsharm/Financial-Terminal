"""AI calls for educational market analysis.

Provider priority: Groq (free, 14 400 req/day) → Gemini fallback.
Set GROQ_API_KEY in .env for the primary provider (free at console.groq.com).
Set GEMINI_API_KEY as a fallback if you already have one.

Both keys are read from the environment so they never appear in client code.
Compliance: prompts keep the model educational and free of buy/sell/hold recs.
"""
from __future__ import annotations

import json

import requests
import streamlit as st

from lib.config import get_gemini_key, get_groq_key

# ── Groq (primary) ────────────────────────────────────────────────────────────
_GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions"
# llama-3.3-70b-versatile: excellent quality; free tier 14 400 req/day 30 req/min
_GROQ_MODEL = "llama-3.3-70b-versatile"

# ── Gemini (fallback) ─────────────────────────────────────────────────────────
_GEMINI_MODEL    = "gemini-2.0-flash"
_GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "{model}:generateContent"
)

SYSTEM_PROMPT = (
    "You are an educational markets analyst for a personal-research terminal "
    "called Motherboard. Your audience is studying how to think about companies "
    "and markets. Rules you must always follow:\n"
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


def is_available() -> bool:
    """True if at least one AI provider key is configured."""
    return get_groq_key() is not None or get_gemini_key() is not None


def active_provider() -> str:
    """Return a human-readable name of whichever provider will be used."""
    if get_groq_key():
        return "Groq (Llama 3.3)"
    if get_gemini_key():
        return "Gemini 2.0 Flash"
    return "none"


# ── private provider calls ────────────────────────────────────────────────────

def _call_groq(user_prompt: str, max_tokens: int) -> str:
    key = get_groq_key()
    if not key:
        raise AnalystError("No Groq key configured.")
    try:
        resp = requests.post(
            _GROQ_URL,
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json"},
            json={
                "model": _GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user",   "content": user_prompt},
                ],
                "max_tokens": max_tokens,
                "temperature": 0.4,
            },
            timeout=60,
        )
    except requests.RequestException as exc:
        raise AnalystError(f"Network error contacting Groq: {exc}")

    if resp.status_code == 429:
        raise AnalystError(
            "Groq rate limit hit. The free tier allows 30 req/min and "
            "14 400 req/day — wait a moment and try again."
        )
    if resp.status_code in (401, 403):
        raise AnalystError(
            "Groq rejected the API key. Re-check GROQ_API_KEY in your "
            ".env or Streamlit secrets."
        )
    if resp.status_code != 200:
        detail = ""
        try:
            detail = resp.json().get("error", {}).get("message", "")
        except Exception:
            detail = resp.text[:200]
        raise AnalystError(f"Groq API error {resp.status_code}: {detail}")

    try:
        return resp.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError):
        raise AnalystError("Groq returned an empty response.")


def _call_gemini(user_prompt: str, max_tokens: int) -> str:
    key = get_gemini_key()
    if not key:
        raise AnalystError("No Gemini key configured.")
    url = _GEMINI_ENDPOINT.format(model=_GEMINI_MODEL)
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": max_tokens},
    }
    try:
        resp = requests.post(url, params={"key": key}, json=body, timeout=60)
    except requests.RequestException as exc:
        raise AnalystError(f"Network error contacting Gemini: {exc}")
    if resp.status_code == 429:
        raise AnalystError(
            "Gemini usage limit reached. The free tier caps requests per minute "
            "and per day — wait a minute and try again, or check your key's quota "
            "at aistudio.google.com."
        )
    if resp.status_code in (401, 403):
        raise AnalystError(
            "Gemini rejected the API key. Re-check GEMINI_API_KEY in your "
            ".env or Streamlit secrets."
        )
    if resp.status_code != 200:
        detail = ""
        try:
            detail = resp.json().get("error", {}).get("message", "")
        except Exception:
            detail = resp.text[:200]
        raise AnalystError(f"Gemini API error {resp.status_code}: {detail}")
    try:
        data = resp.json()
        parts = data["candidates"][0]["content"]["parts"]
        return "".join(p.get("text", "") for p in parts).strip()
    except (KeyError, IndexError):
        raise AnalystError("Gemini returned an empty or blocked response.")


def _call(user_prompt: str, max_tokens: int = 1400) -> str:
    """Call the best available provider; raises AnalystError on failure."""
    if get_groq_key():
        return _call_groq(user_prompt, max_tokens)
    if get_gemini_key():
        return _call_gemini(user_prompt, max_tokens)
    raise AnalystError(
        "No AI key configured. Add GROQ_API_KEY (free at console.groq.com) "
        "or GEMINI_API_KEY to your .env / Streamlit secrets."
    )


# ── public helpers ────────────────────────────────────────────────────────────

def _fmt(d: dict) -> str:
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
        "Given these latest macroeconomic indicators, write an educational "
        "'macro pulse-check' explaining what the current readings suggest about "
        "the economy's state (growth, inflation, labor, rates).\n\n"
        f"Data: {data}\n\n"
        "Structure: '## Where things stand', '## Cross-currents', "
        "'## What to watch'. Explain how the indicators relate to each other. "
        "Educational only; no market-timing or investment advice."
    )
    return _call(prompt)
