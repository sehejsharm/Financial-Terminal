"""Download company/ETF logos into assets/logos/<TICKER>.<ext>.

For each ticker we try several sources in order of quality and pick the best
available result:

  1. simple-icons (SVG via jsdelivr CDN) - recolored to white for dark mode
  2. vectorlogo.zone (SVG)
  3. apple-touch-icon from the brand's own domain (PNG)
  4. Google faviconV2 at size=256 (PNG)
  5. DuckDuckGo icons (ICO/PNG)

Run from the project root:
    python scripts/fetch_logos.py
    python scripts/fetch_logos.py AAPL MSFT      # only specific tickers
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import requests

# Make `lib` importable when run as a script.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lib.logos import DOMAIN_MAP  # noqa: E402

LOGO_DIR = ROOT / "assets" / "logos"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; LogoFetcher/1.0)"}
TIMEOUT = 12
MIN_RASTER_BYTES = 600  # reject 1x1 trackers / empty responses

# Tickers whose brand exists in simple-icons, mapped to the icon slug.
SIMPLE_ICONS_SLUG: dict[str, str] = {
    "AAPL": "apple", "MSFT": None, "GOOGL": "google", "GOOG": "google",
    "AMZN": "amazon", "META": "meta", "NVDA": "nvidia", "TSLA": "tesla",
    "ADBE": "adobe", "AMD": "amd", "INTC": "intel", "CSCO": "cisco",
    "QCOM": "qualcomm", "IBM": "ibm", "ORCL": "oracle", "CRM": "salesforce",
    "NOW": "servicenow", "INTU": "intuit", "PLTR": "palantir",
    "SNOW": "snowflake", "UBER": "uber", "ABNB": "airbnb", "SHOP": "shopify",
    "DELL": "dell", "HPQ": "hp", "TEAM": "atlassian", "DDOG": "datadog",
    "NET": "cloudflare", "MDB": "mongodb", "ZS": "zscaler", "CRWD": "crowdstrike",
    "FTNT": "fortinet", "PANW": "paloaltonetworks", "SPOT": "spotify",
    "NFLX": "netflix", "PYPL": "paypal", "V": "visa", "MA": "mastercard",
    "KO": "cocacola", "PEP": "pepsi", "NKE": "nike", "MCD": "mcdonalds",
    "SBUX": "starbucks", "DIS": "waltdisney", "WMT": "walmart", "TGT": "target",
    "HD": "homedepot", "F": "ford", "GM": "generalmotors", "BA": "boeing",
    "GE": "generalelectric", "UPS": "ups", "T": "att", "VZ": "verizon",
    "TMUS": "tmobile", "CMCSA": "comcast", "PFE": "pfizer", "JNJ": None,
    "MRK": None, "GILD": "gilead", "BKNG": "bookingdotcom", "MAR": "marriott",
    "DASH": "doordash", "COST": "costco", "LOW": "lowes", "XOM": "exxonmobil",
    "CVX": "chevron", "CAT": "caterpillar", "DE": "johndeere", "MMM": None,
    "GS": "goldmansachs", "C": "citigroup", "AXP": "americanexpress",
}


def _ok_image(content: bytes) -> bool:
    if not content or len(content) < MIN_RASTER_BYTES:
        return False
    head = content[:16]
    return (head.startswith(b"\x89PNG") or head[:3] == b"\xff\xd8\xff"
            or head[:4] == b"RIFF" or head[:2] == b"BM"
            or head[:4] in (b"\x00\x00\x01\x00", b"GIF8") or b"<svg" in content[:512])


def _get(url: str) -> bytes | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code == 200 and r.content:
            return r.content
    except requests.RequestException:
        return None
    return None


def _recolor_svg(svg: bytes, color: str = "#ffffff") -> bytes:
    text = svg.decode("utf-8", errors="ignore")
    # simple-icons paths default to black; force a fill on the root <svg>.
    if "<svg" in text and "fill=" not in text.split(">", 1)[0]:
        text = re.sub(r"<svg\b", f'<svg fill="{color}"', text, count=1)
    else:
        text = re.sub(r'fill="#[0-9A-Fa-f]{3,6}"', f'fill="{color}"', text)
    return text.encode("utf-8")


def fetch_simple_icons(ticker: str) -> tuple[bytes, str] | None:
    slug = SIMPLE_ICONS_SLUG.get(ticker)
    if not slug:
        return None
    data = _get(f"https://cdn.jsdelivr.net/npm/simple-icons/icons/{slug}.svg")
    if data and b"<svg" in data:
        return _recolor_svg(data), ".svg"
    return None


def fetch_vectorlogo(ticker: str, domain: str) -> tuple[bytes, str] | None:
    name = domain.split(".")[0]
    for pattern in (f"{name}/{name}-icon.svg", f"{name}/{name}-ar21.svg"):
        data = _get(f"https://www.vectorlogo.zone/logos/{pattern}")
        if data and b"<svg" in data:
            return data, ".svg"
    return None


def fetch_apple_touch(domain: str) -> tuple[bytes, str] | None:
    for path in ("apple-touch-icon.png", "apple-touch-icon-precomposed.png"):
        data = _get(f"https://{domain}/{path}")
        if data and _ok_image(data):
            return data, ".png"
    return None


def fetch_favicon_v2(domain: str) -> tuple[bytes, str] | None:
    url = ("https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON"
           f"&fallback_opts=TYPE,SIZE,URL&url=https://{domain}&size=256")
    data = _get(url)
    if data and _ok_image(data):
        return data, ".png"
    return None


def fetch_duckduckgo(domain: str) -> tuple[bytes, str] | None:
    data = _get(f"https://icons.duckduckgo.com/ip3/{domain}.ico")
    if data and _ok_image(data):
        return data, ".ico"
    return None


def best_logo(ticker: str, domain: str) -> tuple[bytes, str] | None:
    """Try sources in order; SVG wins outright, else largest raster."""
    # Prefer vector sources.
    for fn in (fetch_simple_icons,):
        res = fn(ticker)
        if res:
            return res
    res = fetch_vectorlogo(ticker, domain)
    if res:
        return res

    # Otherwise gather raster candidates and pick the largest.
    candidates = []
    for fn in (fetch_apple_touch, fetch_favicon_v2, fetch_duckduckgo):
        res = fn(domain)
        if res:
            candidates.append(res)
    if candidates:
        return max(candidates, key=lambda c: len(c[0]))
    return None


def main(argv: list[str]) -> int:
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    tickers = [t.upper() for t in argv] if argv else list(DOMAIN_MAP.keys())
    ok = 0
    for tk in tickers:
        domain = DOMAIN_MAP.get(tk)
        if not domain:
            print(f"  skip {tk}: no domain mapping")
            continue
        # Skip if already present.
        if any((LOGO_DIR / f"{tk}{e}").exists()
               for e in (".svg", ".png", ".ico", ".webp", ".jpg")):
            print(f"  have {tk}")
            ok += 1
            continue
        res = best_logo(tk, domain)
        if not res:
            print(f"  MISS {tk} ({domain})")
            continue
        data, ext = res
        (LOGO_DIR / f"{tk}{ext}").write_bytes(data)
        print(f"  ok   {tk}{ext} ({len(data)} bytes)")
        ok += 1
    print(f"\nDone: {ok}/{len(tickers)} tickers have logos in {LOGO_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
