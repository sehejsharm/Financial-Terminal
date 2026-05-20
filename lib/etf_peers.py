"""Curated ETF peer groups for cost comparison.

Each entry maps an ETF to a list of comparable funds in the same broad
exposure, so the ETF Analyzer can surface cheaper alternatives by expense
ratio. Membership is by category, not an endorsement of any fund.
"""
from __future__ import annotations

PEER_GROUPS: dict[str, list[str]] = {
    # US large-cap / total market
    "SPY": ["SPY", "IVV", "VOO", "SPLG"],
    "IVV": ["SPY", "IVV", "VOO", "SPLG"],
    "VOO": ["SPY", "IVV", "VOO", "SPLG"],
    "SPLG": ["SPY", "IVV", "VOO", "SPLG"],
    "VTI": ["VTI", "ITOT", "SCHB"],
    "ITOT": ["VTI", "ITOT", "SCHB"],
    "SCHB": ["VTI", "ITOT", "SCHB"],
    # Nasdaq / large-cap growth
    "QQQ": ["QQQ", "QQQM", "ONEQ"],
    "QQQM": ["QQQ", "QQQM", "ONEQ"],
    "VUG": ["VUG", "IWF", "SCHG", "SPYG"],
    "IWF": ["VUG", "IWF", "SCHG", "SPYG"],
    "SCHG": ["VUG", "IWF", "SCHG", "SPYG"],
    # Value
    "VTV": ["VTV", "IWD", "SCHV", "SPYV"],
    "IWD": ["VTV", "IWD", "SCHV", "SPYV"],
    "SCHV": ["VTV", "IWD", "SCHV", "SPYV"],
    # Dividend
    "SCHD": ["SCHD", "VYM", "DGRO", "HDV", "VIG"],
    "VYM": ["SCHD", "VYM", "DGRO", "HDV", "VIG"],
    "VIG": ["SCHD", "VYM", "DGRO", "HDV", "VIG"],
    "DGRO": ["SCHD", "VYM", "DGRO", "HDV", "VIG"],
    # Small cap
    "IWM": ["IWM", "VB", "IJR", "SCHA"],
    "VB": ["IWM", "VB", "IJR", "SCHA"],
    "IJR": ["IWM", "VB", "IJR", "SCHA"],
    # International developed
    "VEA": ["VEA", "IEFA", "SCHF", "EFA"],
    "IEFA": ["VEA", "IEFA", "SCHF", "EFA"],
    "EFA": ["VEA", "IEFA", "SCHF", "EFA"],
    # Emerging markets
    "VWO": ["VWO", "IEMG", "SCHE", "EEM"],
    "IEMG": ["VWO", "IEMG", "SCHE", "EEM"],
    "EEM": ["VWO", "IEMG", "SCHE", "EEM"],
    # Total international
    "VXUS": ["VXUS", "IXUS"],
    "IXUS": ["VXUS", "IXUS"],
    # Aggregate bonds
    "BND": ["BND", "AGG", "SCHZ"],
    "AGG": ["BND", "AGG", "SCHZ"],
    "SCHZ": ["BND", "AGG", "SCHZ"],
    # Treasuries
    "TLT": ["TLT", "VGLT", "SPTL"],
    "IEF": ["IEF", "VGIT", "SPTI"],
    # Gold
    "GLD": ["GLD", "IAU", "GLDM", "SGOL"],
    "IAU": ["GLD", "IAU", "GLDM", "SGOL"],
    "GLDM": ["GLD", "IAU", "GLDM", "SGOL"],
    # Sector SPDRs vs Vanguard/Fidelity equivalents
    "XLK": ["XLK", "VGT", "FTEC", "IYW"],
    "VGT": ["XLK", "VGT", "FTEC", "IYW"],
    "XLF": ["XLF", "VFH", "FNCL"],
    "XLV": ["XLV", "VHT", "FHLC"],
    "XLE": ["XLE", "VDE", "FENY"],
    "XLY": ["XLY", "VCR", "FDIS"],
    "XLP": ["XLP", "VDC", "FSTA"],
    "XLI": ["XLI", "VIS", "FIDU"],
    "XLU": ["XLU", "VPU", "FUTY"],
    "XLRE": ["XLRE", "VNQ", "USRT", "SCHH"],
    "XLB": ["XLB", "VAW", "FMAT"],
    "XLC": ["XLC", "VOX", "FCOM"],
}


def get_peers(ticker: str) -> list[str]:
    """Return the peer list including the ticker itself, or just the ticker."""
    ticker = ticker.upper()
    if ticker in PEER_GROUPS:
        return PEER_GROUPS[ticker]
    return [ticker]
