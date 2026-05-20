"""Shared configuration and constants."""
import os

from dotenv import load_dotenv

# Load environment variables from .env at import time.
load_dotenv()

APP_NAME = "Stock Market Analyst"
SIDEBAR_BRAND = "📈 Market Analyst"

# Shown on every page footer. Non-negotiable compliance text.
DISCLOSURE = (
    "This dashboard is for educational and informational purposes only. "
    "It is not financial advice, not a recommendation to buy or sell any "
    "security, and is not personalized to your situation. Consult a licensed "
    "advisor before making investment decisions."
)


def get_anthropic_key() -> str | None:
    """Return the Anthropic API key from the environment, or None."""
    key = os.getenv("ANTHROPIC_API_KEY")
    return key.strip() if key and key.strip() else None


def get_fred_key() -> str | None:
    """Return the FRED API key from the environment, or None."""
    key = os.getenv("FRED_API_KEY")
    return key.strip() if key and key.strip() else None
