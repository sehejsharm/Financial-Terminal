"""Company logo handling.

Maps tickers to brand domains (used by scripts/fetch_logos.py) and loads
locally cached logo files as base64 data URLs at render time so the app
never makes a live third-party request for images.
"""
from __future__ import annotations

import base64
from functools import lru_cache
from pathlib import Path

LOGO_DIR = Path(__file__).resolve().parent.parent / "assets" / "logos"

# Ticker -> brand domain, for the top US companies and major ETFs.
DOMAIN_MAP: dict[str, str] = {
    # Mega-cap tech
    "AAPL": "apple.com", "MSFT": "microsoft.com", "GOOGL": "google.com",
    "GOOG": "google.com", "AMZN": "amazon.com", "META": "meta.com",
    "NVDA": "nvidia.com", "TSLA": "tesla.com", "AVGO": "broadcom.com",
    "ORCL": "oracle.com", "CRM": "salesforce.com", "ADBE": "adobe.com",
    "AMD": "amd.com", "INTC": "intel.com", "CSCO": "cisco.com",
    "QCOM": "qualcomm.com", "TXN": "ti.com", "IBM": "ibm.com",
    "NOW": "servicenow.com", "INTU": "intuit.com", "AMAT": "appliedmaterials.com",
    "MU": "micron.com", "ADI": "analog.com", "LRCX": "lamresearch.com",
    "KLAC": "kla.com", "SNPS": "synopsys.com", "CDNS": "cadence.com",
    "PANW": "paloaltonetworks.com", "CRWD": "crowdstrike.com", "FTNT": "fortinet.com",
    "PLTR": "palantir.com", "SNOW": "snowflake.com", "UBER": "uber.com",
    "ABNB": "airbnb.com", "SHOP": "shopify.com", "MRVL": "marvell.com",
    "DELL": "dell.com", "HPQ": "hp.com", "WDAY": "workday.com",
    "TEAM": "atlassian.com", "DDOG": "datadoghq.com", "NET": "cloudflare.com",
    "MDB": "mongodb.com", "ZS": "zscaler.com",
    # Communication / media
    "NFLX": "netflix.com", "DIS": "disney.com", "CMCSA": "comcast.com",
    "T": "att.com", "VZ": "verizon.com", "TMUS": "t-mobile.com",
    "SPOT": "spotify.com",
    # Financials
    "BRK-B": "berkshirehathaway.com", "JPM": "jpmorganchase.com",
    "BAC": "bankofamerica.com", "WFC": "wellsfargo.com", "GS": "goldmansachs.com",
    "MS": "morganstanley.com", "C": "citigroup.com", "SCHW": "schwab.com",
    "AXP": "americanexpress.com", "BLK": "blackrock.com", "SPGI": "spglobal.com",
    "V": "visa.com", "MA": "mastercard.com", "PYPL": "paypal.com",
    "COF": "capitalone.com", "USB": "usbank.com", "PNC": "pnc.com",
    "BX": "blackstone.com", "KKR": "kkr.com",
    # Healthcare
    "UNH": "unitedhealthgroup.com", "JNJ": "jnj.com", "LLY": "lilly.com",
    "ABBV": "abbvie.com", "MRK": "merck.com", "PFE": "pfizer.com",
    "TMO": "thermofisher.com", "ABT": "abbott.com", "DHR": "danaher.com",
    "BMY": "bms.com", "AMGN": "amgen.com", "GILD": "gilead.com",
    "CVS": "cvshealth.com", "MDT": "medtronic.com", "ISRG": "intuitive.com",
    "VRTX": "vrtx.com", "REGN": "regeneron.com", "ELV": "elevancehealth.com",
    # Consumer
    "WMT": "walmart.com", "COST": "costco.com", "HD": "homedepot.com",
    "LOW": "lowes.com", "TGT": "target.com", "NKE": "nike.com",
    "MCD": "mcdonalds.com", "SBUX": "starbucks.com", "CMG": "chipotle.com",
    "KO": "coca-cola.com", "PEP": "pepsico.com", "PG": "pg.com",
    "CL": "colgatepalmolive.com", "MDLZ": "mondelezinternational.com",
    "PM": "pmi.com", "MO": "altria.com", "EL": "elcompanies.com",
    "BKNG": "booking.com", "MAR": "marriott.com", "GM": "gm.com",
    "F": "ford.com", "DASH": "doordash.com",
    # Industrials / energy / materials
    "XOM": "exxonmobil.com", "CVX": "chevron.com", "COP": "conocophillips.com",
    "SLB": "slb.com", "EOG": "eogresources.com", "BA": "boeing.com",
    "CAT": "caterpillar.com", "DE": "deere.com", "GE": "ge.com",
    "HON": "honeywell.com", "UPS": "ups.com", "RTX": "rtx.com",
    "LMT": "lockheedmartin.com", "UNP": "up.com", "MMM": "3m.com",
    "LIN": "linde.com", "FCX": "fcx.com", "NEE": "nexteraenergy.com",
    # Major ETFs
    "SPY": "ssga.com", "VOO": "vanguard.com", "IVV": "ishares.com",
    "VTI": "vanguard.com", "QQQ": "invesco.com", "QQQM": "invesco.com",
    "IWM": "ishares.com", "DIA": "ssga.com", "VEA": "vanguard.com",
    "VWO": "vanguard.com", "VXUS": "vanguard.com", "BND": "vanguard.com",
    "AGG": "ishares.com", "TLT": "ishares.com", "GLD": "ssga.com",
    "SCHD": "schwab.com", "VYM": "vanguard.com", "VUG": "vanguard.com",
    "VTV": "vanguard.com", "VIG": "vanguard.com",
    "XLK": "ssga.com", "XLF": "ssga.com", "XLV": "ssga.com", "XLE": "ssga.com",
    "XLI": "ssga.com", "XLY": "ssga.com", "XLP": "ssga.com", "XLU": "ssga.com",
    "XLRE": "ssga.com", "XLB": "ssga.com", "XLC": "ssga.com",
}

_MIME = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
         ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp"}


@lru_cache(maxsize=512)
def get_logo_data_url(ticker: str) -> str | None:
    """Return a base64 data URL for the ticker's cached logo, or None."""
    if not ticker:
        return None
    ticker = ticker.upper()
    for ext in (".svg", ".png", ".webp", ".jpg", ".jpeg", ".ico"):
        path = LOGO_DIR / f"{ticker}{ext}"
        if path.exists():
            try:
                raw = path.read_bytes()
            except Exception:
                continue
            mime = _MIME.get(ext, "image/png")
            b64 = base64.b64encode(raw).decode("ascii")
            return f"data:{mime};base64,{b64}"
    return None


def logo_img_html(ticker: str, size: int = 28) -> str:
    """Return an <img> tag for the logo, or a neutral monogram fallback."""
    url = get_logo_data_url(ticker)
    if url:
        return (
            f'<img src="{url}" width="{size}" height="{size}" '
            f'style="border-radius:6px;object-fit:contain;background:#1e2230;'
            f'padding:2px;vertical-align:middle;" alt="{ticker}">'
        )
    letter = ticker[0].upper() if ticker else "?"
    return (
        f'<span style="display:inline-flex;align-items:center;justify-content:center;'
        f'width:{size}px;height:{size}px;border-radius:6px;background:#2a2f40;'
        f'color:#cbd5e1;font-weight:700;font-size:{int(size * 0.45)}px;'
        f'vertical-align:middle;">{letter}</span>'
    )
