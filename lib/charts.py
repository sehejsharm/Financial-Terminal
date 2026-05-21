"""Plotly chart helpers.

The signature feature is render_price_chart with four views and a green/red
split at a baseline (zero for Performance, starting price for Area), including
linearly interpolated zero crossings so the color flips exactly where the line
crosses the baseline rather than at the next data point.
"""
from __future__ import annotations

from datetime import datetime

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

GREEN = "#19d27c"
RED = "#ff453a"
GREEN_FILL = "rgba(25, 210, 124, 0.16)"
RED_FILL = "rgba(255, 69, 58, 0.16)"
AMBER = "#ffae00"
NEUTRAL = "#8a8f99"
VOLUME_COLOR = "rgba(120, 130, 150, 0.45)"

# Terminal look.
BG = "#0a0b0d"
GRID = "#1b1e26"
FONT_FAMILY = "JetBrains Mono, Menlo, Consolas, monospace"
FONT_COLOR = "#cdd1d8"

VIEWS = ("Performance", "Price", "Candlestick", "Area")


def _apply_terminal_layout(fig, height: int, title: str = "") -> None:
    fig.update_layout(
        template="plotly_dark",
        height=height,
        title=title,
        margin=dict(l=10, r=70, t=40 if title else 18, b=10),
        hovermode="x unified",
        showlegend=False,
        paper_bgcolor=BG,
        plot_bgcolor=BG,
        font=dict(family=FONT_FAMILY, color=FONT_COLOR, size=13),
    )
    fig.update_xaxes(showgrid=False, zeroline=False, linecolor=GRID)
    fig.update_yaxes(showgrid=True, gridcolor=GRID, zeroline=False)


def _interp_x(x0, x1, y0, y1, baseline):
    """X-coordinate where the segment (x0,y0)->(x1,y1) crosses baseline."""
    if y1 == y0:
        return x0
    frac = (baseline - y0) / (y1 - y0)
    if isinstance(x0, (pd.Timestamp, datetime)):
        t0 = pd.Timestamp(x0).value
        t1 = pd.Timestamp(x1).value
        return pd.Timestamp(int(t0 + frac * (t1 - t0)))
    return x0 + frac * (x1 - x0)


def split_traces(x, y, baseline: float):
    """Split a line at a horizontal baseline into above/below series.

    Returns (xs, above, below) where xs has interpolated crossing points
    inserted, and above/below carry None where the series is on the other
    side of the baseline. Crossing points are set to the baseline value in
    both series so the colored segments meet exactly on the line.
    """
    xs: list = []
    above: list = []
    below: list = []
    n = len(y)
    for i in range(n):
        yi = y[i]
        xs.append(x[i])
        above.append(yi if yi >= baseline else None)
        below.append(yi if yi <= baseline else None)
        if i < n - 1:
            y0, y1 = y[i], y[i + 1]
            if (y0 - baseline) * (y1 - baseline) < 0:
                xc = _interp_x(x[i], x[i + 1], y0, y1, baseline)
                xs.append(xc)
                above.append(baseline)
                below.append(baseline)
    return xs, above, below


def _badge(fig, x_last, y_last, pct: float):
    """Anchor a colored return badge at the last data point."""
    color = GREEN if pct >= 0 else RED
    sign = "+" if pct >= 0 else ""
    fig.add_annotation(
        x=x_last,
        y=y_last,
        text=f"  {sign}{pct:.2f}%  ",
        showarrow=False,
        xanchor="left",
        font=dict(color="#ffffff", size=13, family="Arial Black"),
        bgcolor=color,
        borderpad=4,
        opacity=0.95,
    )


def _empty_fig(message: str, height: int) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=message, showarrow=False,
                       font=dict(color=NEUTRAL, size=15))
    fig.update_layout(template="plotly_dark", height=height,
                      margin=dict(l=10, r=10, t=30, b=10),
                      paper_bgcolor=BG, plot_bgcolor=BG,
                      font=dict(family=FONT_FAMILY, color=FONT_COLOR),
                      xaxis=dict(visible=False), yaxis=dict(visible=False))
    return fig


MA_COLORS = ["#ffb000", "#22d3ee", "#e879f9", "#a3e635", "#fb923c"]


def render_price_chart(
    df: pd.DataFrame,
    view: str = "Performance",
    baseline_price: float | None = None,
    title: str = "",
    show_volume: bool = False,
    height: int = 460,
    mas: list[int] | None = None,
    bollinger: bool = False,
) -> go.Figure:
    """Render a price chart in one of four views.

    baseline_price: optional reference price. For 1D intraday charts pass
    yesterday's close so the Performance/Area split and the return badge are
    measured against the prior close instead of the first intraday bar.

    mas: simple moving-average windows to overlay (e.g. [20, 50, 200]).
    bollinger: overlay 20-period Bollinger Bands (±2 standard deviations).
    Overlays apply to Price/Candlestick/Area views (not Performance).
    """
    if df is None or df.empty or "Close" not in df.columns:
        return _empty_fig("No data available", height)

    df = df.dropna(subset=["Close"])
    if df.empty:
        return _empty_fig("No data available", height)

    x = list(df.index)
    close = df["Close"].astype(float)
    base = float(baseline_price) if baseline_price is not None else float(close.iloc[0])

    if show_volume and "Volume" in df.columns:
        fig = make_subplots(
            rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.03,
            row_heights=[0.78, 0.22],
        )
    else:
        fig = go.Figure()
        show_volume = False

    def add(trace, secondary_row=False):
        if show_volume:
            fig.add_trace(trace, row=2 if secondary_row else 1, col=1)
        else:
            fig.add_trace(trace)

    end_pct = (float(close.iloc[-1]) / base - 1.0) * 100.0 if base else 0.0

    if view == "Candlestick":
        add(go.Candlestick(
            x=x, open=df["Open"], high=df["High"], low=df["Low"], close=df["Close"],
            increasing_line_color=GREEN, decreasing_line_color=RED,
            increasing_fillcolor=GREEN, decreasing_fillcolor=RED,
            name="Price", showlegend=False,
        ))
        fig.update_layout(xaxis_rangeslider_visible=False)

    elif view == "Price":
        line_color = GREEN if end_pct >= 0 else RED
        add(go.Scatter(x=x, y=close, mode="lines", line=dict(color=line_color, width=2),
                       name="Price", showlegend=False))

    elif view == "Area":
        xs, above, below = split_traces(x, list(close.values), base)
        flat = [base] * len(xs)
        # Green fill above baseline.
        add(go.Scatter(x=xs, y=flat, mode="lines", line=dict(width=0),
                       hoverinfo="skip", showlegend=False))
        add(go.Scatter(x=xs, y=above, mode="lines", line=dict(color=GREEN, width=2),
                       fill="tonexty", fillcolor=GREEN_FILL, connectgaps=False,
                       name="Above", showlegend=False))
        # Red fill below baseline.
        add(go.Scatter(x=xs, y=flat, mode="lines", line=dict(width=0),
                       hoverinfo="skip", showlegend=False))
        add(go.Scatter(x=xs, y=below, mode="lines", line=dict(color=RED, width=2),
                       fill="tonexty", fillcolor=RED_FILL, connectgaps=False,
                       name="Below", showlegend=False))

    else:  # Performance
        pct = (close / base - 1.0) * 100.0
        xs, above, below = split_traces(x, list(pct.values), 0.0)
        add(go.Scatter(x=xs, y=above, mode="lines", line=dict(color=GREEN, width=2),
                       connectgaps=False, name="Above", showlegend=False))
        add(go.Scatter(x=xs, y=below, mode="lines", line=dict(color=RED, width=2),
                       connectgaps=False, name="Below", showlegend=False))
        fig.add_hline(y=0, line=dict(color=NEUTRAL, width=1, dash="dot"))

    # Overlays (price-scale views only).
    overlay_legend = False
    if view != "Performance" and (mas or bollinger):
        for i, w in enumerate(mas or []):
            if len(close) >= w:
                ma = close.rolling(w).mean()
                add(go.Scatter(x=x, y=ma, mode="lines", name=f"SMA {w}",
                               line=dict(color=MA_COLORS[i % len(MA_COLORS)], width=1.3),
                               showlegend=True))
                overlay_legend = True
        if bollinger and len(close) >= 20:
            mid = close.rolling(20).mean()
            sd = close.rolling(20).std()
            band = dict(color="rgba(150,160,175,0.6)", width=1, dash="dot")
            add(go.Scatter(x=x, y=mid + 2 * sd, mode="lines", name="BB upper",
                           line=band, showlegend=True))
            add(go.Scatter(x=x, y=mid - 2 * sd, mode="lines", name="BB lower",
                           line=band, fill="tonexty",
                           fillcolor="rgba(150,160,175,0.06)", showlegend=False))
            overlay_legend = True

    # Return badge anchored at last point.
    y_last = (
        (float(close.iloc[-1]) / base - 1.0) * 100.0
        if view == "Performance"
        else float(close.iloc[-1])
    )
    _badge(fig, x[-1], y_last, end_pct)

    if show_volume:
        colors = [
            GREEN if c >= o else RED
            for o, c in zip(df["Open"], df["Close"])
        ]
        fig.add_trace(
            go.Bar(x=x, y=df["Volume"], marker_color=colors, name="Volume",
                   showlegend=False, opacity=0.5),
            row=2, col=1,
        )
        fig.update_yaxes(title_text="Vol", row=2, col=1, showgrid=False)

    _apply_terminal_layout(fig, height, title)
    if overlay_legend:
        fig.update_layout(showlegend=True,
                          legend=dict(orientation="h", yanchor="bottom", y=1.0,
                                      x=0, bgcolor="rgba(0,0,0,0)",
                                      font=dict(size=11)))
    return fig


def render_backtest_chart(result: dict, height: int = 460) -> go.Figure:
    """Price with entry/exit markers (top) and strategy vs buy&hold equity."""
    if not result:
        return _empty_fig("Not enough data to backtest", height)
    close = result["close"]
    x = list(close.index)
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.05,
                        row_heights=[0.55, 0.45],
                        subplot_titles=("Price & signals", "Growth of 1 unit"))
    fig.add_trace(go.Scatter(x=x, y=close, mode="lines", name="Price",
                             line=dict(color=NEUTRAL, width=1.4)), row=1, col=1)
    ent, exi = result.get("entries"), result.get("exits")
    if ent is not None and len(ent):
        fig.add_trace(go.Scatter(x=list(ent.index), y=ent.values, mode="markers",
                                 name="Entry", marker=dict(color=GREEN, size=9,
                                 symbol="triangle-up")), row=1, col=1)
    if exi is not None and len(exi):
        fig.add_trace(go.Scatter(x=list(exi.index), y=exi.values, mode="markers",
                                 name="Exit", marker=dict(color=RED, size=9,
                                 symbol="triangle-down")), row=1, col=1)
    eq, bh = result["equity"], result["buy_hold"]
    fig.add_trace(go.Scatter(x=list(eq.index), y=eq.values, mode="lines",
                             name="Strategy", line=dict(color=AMBER, width=1.8)),
                  row=2, col=1)
    fig.add_trace(go.Scatter(x=list(bh.index), y=bh.values, mode="lines",
                             name="Buy & hold",
                             line=dict(color="#6b7280", width=1.4, dash="dot")),
                  row=2, col=1)
    _apply_terminal_layout(fig, height)
    fig.update_layout(showlegend=True,
                      legend=dict(orientation="h", y=1.08, x=0,
                                  bgcolor="rgba(0,0,0,0)", font=dict(size=11)))
    return fig


def render_sparkline(df: pd.DataFrame, baseline_price: float | None = None,
                     height: int = 60) -> go.Figure:
    """Small green/red split sparkline for the Market Pulse grid cards."""
    fig = go.Figure()
    if df is None or df.empty or "Close" not in df.columns:
        fig.update_layout(template="plotly_dark", height=height,
                          margin=dict(l=0, r=0, t=0, b=0),
                          xaxis=dict(visible=False), yaxis=dict(visible=False))
        return fig

    close = df["Close"].dropna().astype(float)
    x = list(range(len(close)))
    base = float(baseline_price) if baseline_price is not None else float(close.iloc[0])
    xs, above, below = split_traces(x, list(close.values), base)
    fig.add_trace(go.Scatter(x=xs, y=above, mode="lines",
                             line=dict(color=GREEN, width=1.6), connectgaps=False))
    fig.add_trace(go.Scatter(x=xs, y=below, mode="lines",
                             line=dict(color=RED, width=1.6), connectgaps=False))
    fig.update_layout(
        template="plotly_dark", height=height,
        margin=dict(l=0, r=0, t=0, b=0), showlegend=False,
        xaxis=dict(visible=False), yaxis=dict(visible=False),
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
    )
    return fig
