"""Shared configuration and constants."""
import os

from dotenv import load_dotenv

# Load environment variables from .env at import time.
load_dotenv()

APP_NAME = "Motherboard"
SIDEBAR_BRAND = "MOTHERBOARD"

# Shown on every page footer. Non-negotiable compliance text.
DISCLOSURE = (
    "This dashboard is for educational and informational purposes only. "
    "It is not financial advice, not a recommendation to buy or sell any "
    "security, and is not personalized to your situation. Consult a licensed "
    "advisor before making investment decisions."
)


def get_gemini_key() -> str | None:
    """Return the Gemini API key from the environment, or None."""
    key = os.getenv("GEMINI_API_KEY")
    return key.strip() if key and key.strip() else None


def get_groq_key() -> str | None:
    """Return the Groq API key from the environment, or None.

    Free key at console.groq.com — 14 400 req/day, 30 req/min.
    Much more generous than Gemini's free tier.
    """
    key = os.getenv("GROQ_API_KEY")
    return key.strip() if key and key.strip() else None


def get_fred_key() -> str | None:
    """Return the FRED API key from the environment, or None."""
    key = os.getenv("FRED_API_KEY")
    return key.strip() if key and key.strip() else None
