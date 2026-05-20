"""Shared Streamlit UI helpers: page setup, formatting, gauges, chips."""
from __future__ import annotations

import plotly.graph_objects as go
import streamlit as st

from lib.config import APP_NAME, DISCLOSURE, SIDEBAR_BRAND

_TONE_COLORS = {
    "positive": "#22c55e",
    "neutral": "#9ca3af",
    "caution": "#f59e0b",
}

_CSS = """
<style>
  .block-container { padding-top: 2.2rem; max-width: 1300px; }
  section.main, .stMarkdown, .stMetric, p, li, span { font-size: 17px; }
  [data-testid="stSidebar"] { font-size: 16px; }
  .sma-brand { font-size: 22px; font-weight: 800; padding: 4px 0 12px 0; }
  .sma-chip {
    display:flex; justify-content:space-between; align-items:center;
    padding:8px 12px; margin:6px 0; border-radius:10px;
    background:#161a26; border-left:4px solid #9ca3af;
  }
  .sma-chip .lab { color:#94a3b8; font-size:14px; }
  .sma-chip .val { font-weight:700; font-size:15px; }
  .sma-news {
    padding:12px 14px; margin:8px 0; border-radius:10px; background:#141822;
    border:1px solid #232838;
  }
  .sma-news a { color:#e5e7eb; text-decoration:none; font-weight:700; font-size:16px; }
  .sma-news .meta { color:#7c8699; font-size:13px; margin:4px 0; }
  .sma-news .sum { color:#aab2c0; font-size:14px; }
  .sma-row {
    display:flex; align-items:center; gap:10px; padding:8px 6px;
    border-bottom:1px solid #20242f;
  }
  .sma-row .nm { color:#cbd5e1; }
  .sma-row .tk { font-weight:700; }
</style>
"""


def setup_page(page_title: str, page_icon: str = "📈") -> None:
    """Standard page config + global styling + sidebar branding."""
    st.set_page_config(page_title=f"{page_title} · {APP_NAME}",
                       page_icon=page_icon, layout="wide")
    st.markdown(_CSS, unsafe_allow_html=True)
    with st.sidebar:
        st.markdown(f'<div class="sma-brand">{SIDEBAR_BRAND}</div>',
                    unsafe_allow_html=True)
        st.caption("Educational & personal-research dashboard")


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
    color = "#22c55e" if v >= 0 else "#ef4444"
    return f'<span style="color:{color};font-weight:700;">{v:+.{digits}f}%</span>'
