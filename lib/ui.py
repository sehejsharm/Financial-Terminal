"""Shared Streamlit UI helpers: page setup, formatting, gauges, chips."""
from __future__ import annotations

import plotly.graph_objects as go
import streamlit as st

from lib.config import APP_NAME, DISCLOSURE, SIDEBAR_BRAND

_TONE_COLORS = {
    "positive": "#19d27c",
    "neutral": "#8a8f99",
    "caution": "#ffae00",
}

_CURRENCY_SYMBOLS = {
    "INR": "₹", "USD": "$", "EUR": "€", "GBP": "£",
    "JPY": "¥", "CNY": "¥", "HKD": "HK$", "AUD": "A$",
    "CAD": "C$", "SGD": "S$",
}

# Bloomberg-style terminal theme: near-black, amber accents, monospace numerals.
_CSS = """
<style>
  :root { --amber:#ffae00; --bg:#0a0b0d; --panel:#101218; --line:#1f232c;
          --txt:#cdd1d8; --mut:#7d828c; --green:#19d27c; --red:#ff453a; }
  html, body, [data-testid="stAppViewContainer"], [data-testid="stHeader"] {
    background:var(--bg) !important;
  }
  .block-container { padding-top: 1.4rem; max-width: 1500px; }
  section.main, .stMarkdown, p, li, span, label, .stMetric {
    font-family: "JetBrains Mono","Menlo","Consolas",monospace;
  }
  section.main, .stMarkdown, p, li { font-size: 15px; color:var(--txt); }
  h1, h2, h3 { font-family:"JetBrains Mono",monospace !important;
    letter-spacing:0.06em; text-transform:uppercase; }
  h1 { font-size: 26px !important; color:#fff; border-bottom:2px solid var(--amber);
    padding-bottom:8px; }
  h2, h3 { color:var(--amber) !important; font-size:16px !important; }
  [data-testid="stSidebar"] { background:#070809; border-right:1px solid var(--line); }
  [data-testid="stMetricValue"] { font-family:"JetBrains Mono",monospace; }
  [data-testid="stMetric"] {
    background:var(--panel); border:1px solid var(--line); border-radius:4px;
    padding:8px 12px;
  }
  .sma-brand { font-size: 18px; font-weight: 800; letter-spacing:0.18em;
    color:var(--amber); padding: 6px 0 2px 0; border-bottom:1px solid var(--line); }
  .sma-tag { color:var(--mut); font-size:11px; letter-spacing:0.15em;
    text-transform:uppercase; margin-bottom:10px; }
  .sma-card {
    background:var(--panel); border:1px solid var(--line); border-radius:4px;
    padding:10px 12px; height:100%;
  }
  .sma-card .nm { color:var(--mut); font-size:11px; letter-spacing:0.08em;
    text-transform:uppercase; }
  .sma-card .px { font-size:18px; font-weight:700; color:#fff; }
  .sma-chip {
    display:flex; justify-content:space-between; align-items:center;
    padding:7px 11px; margin:5px 0; border-radius:3px;
    background:var(--panel); border-left:3px solid var(--mut);
    border-top:1px solid var(--line); border-right:1px solid var(--line);
    border-bottom:1px solid var(--line);
  }
  .sma-chip .lab { color:var(--mut); font-size:12px; letter-spacing:0.05em;
    text-transform:uppercase; }
  .sma-chip .val { font-weight:700; font-size:14px; }
  .sma-news {
    padding:11px 13px; margin:7px 0; border-radius:3px; background:var(--panel);
    border:1px solid var(--line); border-left:3px solid var(--amber);
  }
  .sma-news a { color:#fff; text-decoration:none; font-weight:700; font-size:15px; }
  .sma-news .meta { color:var(--amber); font-size:11px; margin:4px 0;
    letter-spacing:0.05em; text-transform:uppercase; }
  .sma-news .sum { color:var(--mut); font-size:13px; }
  .sma-row {
    display:flex; align-items:center; gap:10px; padding:7px 6px;
    border-bottom:1px solid var(--line);
  }
  .sma-row .nm { color:var(--txt); }
  .sma-row .tk { font-weight:700; color:#fff; }
  hr { border-color:var(--line); }
</style>
"""


def setup_page(page_title: str, page_icon: str = None) -> None:
    """Standard page config + global styling + sidebar branding."""
    st.set_page_config(page_title=f"{page_title} - {APP_NAME}",
                       page_icon=page_icon, layout="wide")
    st.markdown(_CSS, unsafe_allow_html=True)
    with st.sidebar:
        st.markdown(f'<div class="sma-brand">{SIDEBAR_BRAND}</div>',
                    unsafe_allow_html=True)
        st.markdown('<div class="sma-tag">India + Global · Educational</div>',
                    unsafe_allow_html=True)


def disclosure() -> None:
    """Render the compliance disclosure footer."""
    st.divider()
    st.caption(DISCLOSURE)


def human_number(n: float | int | None, prefix: str = "") -> str:
    if n is None:
        return "—"
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "—"
    sign = "-" if n < 0 else ""
    n = abs(n)
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if n >= div:
            return f"{sign}{prefix}{n / div:.2f}{suf}"
    return f"{sign}{prefix}{n:,.2f}"


def fmt_pct(v: float | None, digits: int = 2) -> str:
    if v is None:
        return "—"
    return f"{v:+.{digits}f}%"


def fmt_num(v: float | None, digits: int = 2, suffix: str = "") -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):,.{digits}f}{suffix}"
    except (TypeError, ValueError):
        return "—"


def cur_symbol(code: str | None) -> str:
    """Return a currency symbol for a 3-letter code (default empty)."""
    if not code:
        return ""
    return _CURRENCY_SYMBOLS.get(code.upper(), "")


def _gauge(value: float, title: str, subtitle: str, steps: list[tuple]) -> go.Figure:
    value = max(0.0, min(100.0, float(value)))
    fig = go.Figure(go.Indicator(
        mode="gauge+number",
        value=value,
        number={"font": {"size": 40, "color": "#e5e7eb"}, "suffix": ""},
        title={"text": f"<b>{title}</b>", "font": {"size": 18, "color": "#e5e7eb"}},
        gauge={
            "axis": {"range": [0, 100], "tickwidth": 1, "tickcolor": "#4b5563"},
            "bar": {"color": "rgba(0,0,0,0)"},  # hide bar; needle shown via threshold
            "borderwidth": 0,
            "steps": [{"range": [a, b], "color": c} for a, b, c in steps],
            "threshold": {
                "line": {"color": "#e5e7eb", "width": 5},
                "thickness": 0.85,
                "value": value,
            },
        },
    ))
    fig.update_layout(
        template="plotly_dark", height=240,
        margin=dict(l=20, r=20, t=50, b=10),
        paper_bgcolor="rgba(0,0,0,0)",
        font=dict(family="JetBrains Mono, Consolas, monospace", color="#cdd1d8"),
    )
    if subtitle:
        fig.add_annotation(text=subtitle, x=0.5, y=-0.05, showarrow=False,
                           font=dict(size=13, color="#94a3b8"))
    return fig


def quality_gauge(value: float, title: str, subtitle: str = "") -> go.Figure:
    """Red (low) to green (high) gauge for quality/strength scores."""
    steps = [(0, 20, "#ef4444"), (20, 40, "#f97316"), (40, 60, "#eab308"),
             (60, 80, "#84cc16"), (80, 100, "#22c55e")]
    return _gauge(value, title, subtitle, steps)


def risk_gauge(value: float, title: str = "Risk score", subtitle: str = "") -> go.Figure:
    """Green (conservative) to red (very aggressive) gauge for risk scores."""
    steps = [(0, 20, "#22c55e"), (20, 40, "#84cc16"), (40, 60, "#eab308"),
             (60, 80, "#f97316"), (80, 100, "#ef4444")]
    return _gauge(value, title, subtitle, steps)


def render_chips(chips: list[dict]) -> None:
    """Render the At-a-glance descriptive chips."""
    html = []
    for c in chips:
        color = _TONE_COLORS.get(c.get("tone", "neutral"), "#9ca3af")
        html.append(
            f'<div class="sma-chip" style="border-left-color:{color};">'
            f'<span class="lab">{c["label"]}</span>'
            f'<span class="val" style="color:{color};">{c["value"]}</span></div>'
        )
    st.markdown("".join(html), unsafe_allow_html=True)


def color_pct_html(v: float | None, digits: int = 2) -> str:
    if v is None:
        return '<span style="color:#9ca3af;">—</span>'
    color = "#19d27c" if v >= 0 else "#ff453a"
    return f'<span style="color:{color};font-weight:700;">{v:+.{digits}f}%</span>'
