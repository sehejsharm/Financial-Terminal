"use client";

import {
  ColorType, createChart, IChartApi, ISeriesApi, LineStyle, PriceScaleMode, UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { bollinger, ema, macd, rsi, sma } from "@/lib/indicators";
import {
  adx, atr, cci, donchian, ichimoku, keltner, mfi, obv, psar, roc,
  stochastic, supertrend, vwap, williamsR, type Bar as IBar,
} from "@/lib/indicatorsPlus";
import { useQuote } from "@/lib/useQuote";

// yfinance serialises columns capitalised (Date/Close/Open…); Twelve Data uses
// lowercase. Accept both so the chart never silently renders empty.
type Candle = Record<string, string | number | null | undefined>;

function pick(c: Candle, keys: string[]): number | string | null {
  for (const k of keys) {
    const v = c[k];
    if (v !== null && v !== undefined && v !== "") return v as number | string;
  }
  return null;
}

/** Read a theme palette variable ("r g b" triplet) as an rgb()/rgba() string,
 *  so the chart follows the active theme instead of hardcoding dark hexes. */
function themeColor(name: string, fallback: string, alpha?: number): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const [r, g, b] = raw.split(/\s+/);
  return alpha != null ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`;
}

type OHLCPoint = {
  time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number;
};

function parseCandles(data: Candle[]): OHLCPoint[] {
  return data
    .map((c) => {
      const rawTime = pick(c, ["time", "Date", "Datetime", "date", "datetime", "index"]);
      const t = typeof rawTime === "string"
        // TD intraday timestamps are "YYYY-MM-DD HH:MM:SS" — Safari refuses the
        // space separator, so normalise to ISO before parsing.
        ? Math.floor(new Date(rawTime.replace(" ", "T")).getTime() / 1000)
        : Number(rawTime);
      const close = Number(pick(c, ["close", "Close"]) ?? NaN);
      const open = Number(pick(c, ["open", "Open"]) ?? close);
      const high = Number(pick(c, ["high", "High"]) ?? Math.max(open, close));
      const low = Number(pick(c, ["low", "Low"]) ?? Math.min(open, close));
      const volume = Number(pick(c, ["volume", "Volume"]) ?? 0);
      return { time: t as UTCTimestamp, open, high, low, close, volume };
    })
    .filter((p) => Number.isFinite(p.close) && p.close > 0 && Number.isFinite(p.time))
    .sort((a, b) => (a.time as number) - (b.time as number))
    // Dedupe equal timestamps (mixed-provider edge case) — lightweight-charts
    // throws on non-ascending times.
    .filter((p, i, arr) => i === 0 || (p.time as number) > (arr[i - 1].time as number));
}

export type ChartType = "area" | "candles" | "line";
export type Overlay =
  | "SMA10" | "SMA20" | "SMA50" | "SMA100" | "SMA200"
  | "EMA9" | "EMA21" | "EMA50"
  | "BB" | "VWAP" | "PSAR" | "DONCH" | "KELT" | "SUPER" | "ICHI";
export type Pane =
  | "none" | "RSI" | "MACD" | "STOCH" | "ATR" | "ADX"
  | "OBV" | "CCI" | "WILLR" | "MFI" | "ROC";

export type ChartConfig = {
  type: ChartType;
  overlays: Overlay[];
  pane: Pane;
  volume: boolean;
  log: boolean;
};

export const DEFAULT_CHART_CONFIG: ChartConfig = {
  type: "area", overlays: [], pane: "none", volume: true, log: false,
};

const OVERLAY_COLORS: Record<Overlay, string> = {
  SMA10: "#74c0fc",
  SMA20: "#4dabf7",   // blue
  SMA50: "#b197fc",   // violet
  SMA100: "#f783ac",
  SMA200: "#ff922b",  // orange
  EMA9: "#63e6be",
  EMA21: "#3bc9db",   // cyan
  EMA50: "#9775fa",
  BB: "#868e96",      // grey band
  VWAP: "#ffd43b",
  PSAR: "#e599f7",
  DONCH: "#8ce99a",
  KELT: "#ffc078",
  SUPER: "#69db7c",
  ICHI: "#a5d8ff",
};

/** Grouped for the toolbar, so 15 overlays don't render as one long row. */
export const OVERLAY_GROUPS: [string, Overlay[]][] = [
  ["MA", ["SMA10", "SMA20", "SMA50", "SMA100", "SMA200", "EMA9", "EMA21", "EMA50"]],
  ["Bands", ["BB", "DONCH", "KELT"]],
  ["Trend", ["PSAR", "SUPER", "ICHI"]],
  ["Volume", ["VWAP"]],
];

export const PANE_OPTIONS: { id: Pane; label: string; hint: string }[] = [
  { id: "RSI", label: "RSI", hint: "Relative Strength Index (14)" },
  { id: "MACD", label: "MACD", hint: "MACD 12/26 with its 9-period signal" },
  { id: "STOCH", label: "STOCH", hint: "Stochastic %K/%D (14,3,3)" },
  { id: "ATR", label: "ATR", hint: "Average True Range (14) — volatility in price units" },
  { id: "ADX", label: "ADX", hint: "Trend strength with +DI / -DI (14)" },
  { id: "OBV", label: "OBV", hint: "On-Balance Volume — needs volume data" },
  { id: "CCI", label: "CCI", hint: "Commodity Channel Index (20)" },
  { id: "WILLR", label: "%R", hint: "Williams %R (14)" },
  { id: "MFI", label: "MFI", hint: "Money Flow Index (14) — volume-weighted RSI" },
  { id: "ROC", label: "ROC", hint: "Rate of change over 12 bars, in percent" },
];

/**
 * TradingView Lightweight Charts price chart with indicator support:
 * area/candles, volume, SMA/EMA/Bollinger overlays, RSI or MACD sub-pane.
 * Colors come from the terminal palette so it matches the active theme.
 */
export function PriceChart({
  data, height = 360, config = DEFAULT_CHART_CONFIG, symbol,
}: { data: Candle[]; height?: number; config?: ChartConfig; symbol?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const paneChartRef = useRef<IChartApi | null>(null);
  // Live-candle append: refs to the price series + last bar so an incoming
  // tick can .update() the final candle instead of rebuilding the chart.
  const priceSeriesRef = useRef<any>(null);
  const seriesKindRef = useRef<ChartType>("area");
  const lastBarRef = useRef<OHLCPoint | null>(null);
  const liveTick = useQuote(symbol ?? null);

  // Colors are read from CSS variables when the chart is (re)built, so a
  // theme or colorblind-palette toggle mid-session must trigger a rebuild —
  // otherwise the chart keeps the old palette until a full page reload.
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeEpoch((n) => n + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const points = useMemo(() => parseCandles(data), [data]);
  const intraday = useMemo(() => {
    if (points.length < 2) return false;
    const span = (points[points.length - 1].time as number) - (points[0].time as number);
    return span / points.length < 24 * 3600;
  }, [points]);

  useEffect(() => {
    if (!ref.current) return;
    const txt = themeColor("--c-txt", "#dfe3ea");
    const line = themeColor("--c-line", "#1c2129");
    const amber = themeColor("--c-amber", "#ffb000");
    const green = themeColor("--c-green", "#1fd286");
    const red = themeColor("--c-red", "#ff4d4f");

    const baseOpts = {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: txt,
        fontFamily: '"JetBrains Mono", monospace',
      },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line, timeVisible: intraday, secondsVisible: false },
      crosshair: { vertLine: { color: amber }, horzLine: { color: amber } },
    } as const;

    const chart = createChart(ref.current, {
      ...baseOpts,
      rightPriceScale: {
        borderColor: line,
        mode: config.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      },
    });
    chartRef.current = chart;

    const closes = points.map((p) => p.close);
    // OHLC-based indicators need the full bar, not just the close.
    const bars: IBar[] = points.map((p) => ({
      time: p.time, open: p.open, high: p.high, low: p.low, close: p.close,
      volume: p.volume ?? null,
    }));

    // ── main price series ────────────────────────────────────────────────
    let priceSeries: ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | ISeriesApi<"Line">;
    if (config.type === "candles") {
      priceSeries = chart.addCandlestickSeries({
        upColor: green, downColor: red,
        wickUpColor: green, wickDownColor: red,
        borderVisible: false,
      });
      priceSeries.setData(points);
    } else if (config.type === "line") {
      priceSeries = chart.addLineSeries({ color: amber, lineWidth: 2 });
      priceSeries.setData(points.map((p) => ({ time: p.time, value: p.close })));
    } else {
      priceSeries = chart.addAreaSeries({
        lineColor: amber,
        topColor: themeColor("--c-amber", "#ffb000", 0.30),
        bottomColor: themeColor("--c-amber", "#ffb000", 0.02),
        lineWidth: 2,
        priceLineColor: amber,
      });
      priceSeries.setData(points.map((p) => ({ time: p.time, value: p.close })));
    }
    // Expose the price series + last bar so live ticks can append (below).
    priceSeriesRef.current = priceSeries;
    seriesKindRef.current = config.type;
    lastBarRef.current = points.length ? { ...points[points.length - 1] } : null;

    // ── volume histogram (bottom 18% of the main pane) ───────────────────
    if (config.volume && points.some((p) => p.volume > 0)) {
      const vol = chart.addHistogramSeries({
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      vol.setData(points.map((p, i) => ({
        time: p.time, value: p.volume,
        color: p.close >= (i > 0 ? points[i - 1].close : p.open)
          ? themeColor("--c-green", "#1fd286", 0.45)
          : themeColor("--c-red", "#ff4d4f", 0.45),
      })));
    }

    // ── overlays ─────────────────────────────────────────────────────────
    const addLine = (vals: (number | null)[], color: string, width: 1 | 2 = 1, dashed = false) => {
      const s = chart.addLineSeries({
        color, lineWidth: width, lastValueVisible: false, priceLineVisible: false,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
        crosshairMarkerVisible: false,
      });
      s.setData(points
        .map((p, i) => ({ time: p.time, value: vals[i] }))
        .filter((d): d is { time: UTCTimestamp; value: number } => d.value != null));
    };
    for (const ov of config.overlays) {
      const c = OVERLAY_COLORS[ov];
      if (ov === "SMA10") addLine(sma(closes, 10), c);
      if (ov === "SMA20") addLine(sma(closes, 20), c);
      if (ov === "SMA50") addLine(sma(closes, 50), c);
      if (ov === "SMA100") addLine(sma(closes, 100), c);
      if (ov === "SMA200") addLine(sma(closes, 200), c, 2);
      if (ov === "EMA9") addLine(ema(closes, 9), c);
      if (ov === "EMA21") addLine(ema(closes, 21), c);
      if (ov === "EMA50") addLine(ema(closes, 50), c);
      if (ov === "BB") {
        const bb = bollinger(closes, 20, 2);
        addLine(bb.upper, c, 1, true);
        addLine(bb.lower, c, 1, true);
        addLine(bb.mid, c);
      }
      if (ov === "VWAP") addLine(vwap(bars), c, 2);
      if (ov === "DONCH") {
        const d = donchian(bars, 20);
        addLine(d.upper, c, 1, true);
        addLine(d.lower, c, 1, true);
      }
      if (ov === "KELT") {
        const k = keltner(bars, 20, 2, 10);
        addLine(k.upper, c, 1, true);
        addLine(k.lower, c, 1, true);
      }
      if (ov === "SUPER") addLine(supertrend(bars, 10, 3).line, c, 2);
      if (ov === "PSAR") {
        // Dots, not a line: the SAR jumps sides and a connected line would
        // draw a meaningless diagonal across the flip.
        const r = psar(bars);
        const dots = chart.addLineSeries({
          color: c, lineWidth: 1, lineStyle: LineStyle.Dotted,
          lastValueVisible: false, priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
        dots.setData(points
          .map((p, i) => ({ time: p.time, value: r.sar[i] }))
          .filter((d): d is { time: UTCTimestamp; value: number } => d.value != null));
      }
      if (ov === "ICHI") {
        const ic = ichimoku(bars, 9, 26, 52);
        addLine(ic.conversion, c);
        addLine(ic.base, "#4dabf7");
        addLine(ic.spanA, "#69db7c", 1, true);
        addLine(ic.spanB, "#ff922b", 1, true);
      }
    }

    // ── RSI / MACD sub-pane, time-synced with the main chart ─────────────
    let pane: IChartApi | null = null;
    if (config.pane !== "none" && paneRef.current) {
      pane = createChart(paneRef.current, {
        ...baseOpts,
        rightPriceScale: { borderColor: line },
      });
      paneChartRef.current = pane;

      // One helper for every sub-pane series, so a new indicator is a couple
      // of lines rather than a copy of the filtering boilerplate.
      const paneLine = (vals: (number | null)[], color: string, width: 1 | 2 = 1,
                        showLast = false) => {
        const s2 = pane!.addLineSeries({
          color, lineWidth: width, lastValueVisible: showLast,
          priceLineVisible: false,
        });
        s2.setData(points
          .map((p, i) => ({ time: p.time, value: vals[i] }))
          .filter((d): d is { time: UTCTimestamp; value: number } => d.value != null));
        return s2;
      };
      const guide = (s2: ReturnType<typeof paneLine>, price: number,
                     color: string, title: string) =>
        s2.createPriceLine({
          price, color, lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title,
        });

      if (config.pane === "RSI") {
        const s2 = paneLine(rsi(closes, 14), amber, 2, true);
        guide(s2, 70, red, "70");
        guide(s2, 30, green, "30");
      } else if (config.pane === "MACD") {
        const m = macd(closes, 12, 26, 9);
        const hist = pane.addHistogramSeries({ lastValueVisible: false, priceLineVisible: false });
        hist.setData(points
          .map((p, i) => ({ time: p.time, value: m.hist[i], color: (m.hist[i] ?? 0) >= 0 ? themeColor("--c-green", "#1fd286", 0.6) : themeColor("--c-red", "#ff4d4f", 0.6) }))
          .filter((d): d is { time: UTCTimestamp; value: number; color: string } => d.value != null));
        paneLine(m.macd, amber, 1);
        paneLine(m.signal, "#4dabf7", 1);
      } else if (config.pane === "STOCH") {
        const st = stochastic(bars, 14, 3, 3);
        const s2 = paneLine(st.k, amber, 2, true);
        paneLine(st.d, "#4dabf7", 1);
        guide(s2, 80, red, "80");
        guide(s2, 20, green, "20");
      } else if (config.pane === "ATR") {
        paneLine(atr(bars, 14), amber, 2, true);
      } else if (config.pane === "ADX") {
        const r = adx(bars, 14);
        const s2 = paneLine(r.adx, amber, 2, true);
        paneLine(r.plusDi, green, 1);
        paneLine(r.minusDi, red, 1);
        // 25 is the conventional "trending vs ranging" threshold.
        guide(s2, 25, "#868e96", "25");
      } else if (config.pane === "OBV") {
        paneLine(obv(bars), amber, 2, true);
      } else if (config.pane === "CCI") {
        const s2 = paneLine(cci(bars, 20), amber, 2, true);
        guide(s2, 100, red, "100");
        guide(s2, -100, green, "-100");
      } else if (config.pane === "WILLR") {
        const s2 = paneLine(williamsR(bars, 14), amber, 2, true);
        guide(s2, -20, red, "-20");
        guide(s2, -80, green, "-80");
      } else if (config.pane === "MFI") {
        const s2 = paneLine(mfi(bars, 14), amber, 2, true);
        guide(s2, 80, red, "80");
        guide(s2, 20, green, "20");
      } else if (config.pane === "ROC") {
        const s2 = paneLine(roc(closes, 12), amber, 2, true);
        guide(s2, 0, "#868e96", "0");
      }

      // Two-way visible-range sync so pan/zoom moves both charts together.
      let syncing = false;
      const link = (from: IChartApi, to: IChartApi) =>
        from.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (syncing || !range) return;
          syncing = true;
          to.timeScale().setVisibleLogicalRange(range);
          syncing = false;
        });
      link(chart, pane);
      link(pane, chart);
    }

    chart.timeScale().fitContent();
    pane?.timeScale().fitContent();

    return () => {
      chart.remove();
      pane?.remove();
      chartRef.current = null;
      paneChartRef.current = null;
      priceSeriesRef.current = null;
    };
    // Rebuild wholesale on any config/data change — series counts and types
    // vary too much for incremental updates to be worth the bookkeeping.
  }, [points, intraday, themeEpoch, config.type, config.volume, config.log, config.pane,
      config.overlays.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-candle append: fold the latest tick into the final bar via the
  // series' .update() (no rebuild). Only when the tick is FRESH — a stale
  // tick (market closed) must never mutate a historical bar. Extends the
  // last bar's high/low and moves its close to the LTP.
  useEffect(() => {
    const series = priceSeriesRef.current;
    const bar = lastBarRef.current;
    const ltp = liveTick?.ltp;
    // Only a genuine live tick may mutate the last bar — never a REST/cache
    // seed (seeded) and never a stale/closed-market tick.
    if (!series || !bar || ltp == null || liveTick?.stale || liveTick?.seeded) return;
    if (seriesKindRef.current === "candles") {
      const next = { time: bar.time, open: bar.open,
                     high: Math.max(bar.high, ltp), low: Math.min(bar.low, ltp),
                     close: ltp };
      series.update(next);
      lastBarRef.current = { ...bar, high: next.high, low: next.low, close: ltp };
    } else {
      series.update({ time: bar.time, value: ltp });
      lastBarRef.current = { ...bar, close: ltp };
    }
  }, [liveTick]);

  return (
    <div>
      <div ref={ref} style={{ height: config.pane !== "none" ? height - 130 : height }} className="panel" />
      {config.pane !== "none" && (
        <div ref={paneRef} style={{ height: 120 }} className="panel mt-1" />
      )}
      {points.length === 0 && (
        <div className="text-mut text-xs mt-2">No chart data for this period.</div>
      )}
    </div>
  );
}

/** Toolbar of chart-type / overlay / pane / volume / log toggles. Persists
 *  choices to localStorage so preferences survive navigation. */
export function useChartConfig(): [ChartConfig, (c: ChartConfig) => void] {
  const [config, setConfig] = useState<ChartConfig>(DEFAULT_CHART_CONFIG);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("mb_chart_config");
      if (raw) setConfig({ ...DEFAULT_CHART_CONFIG, ...JSON.parse(raw) });
    } catch { /* defaults */ }
  }, []);
  const update = (c: ChartConfig) => {
    setConfig(c);
    try { localStorage.setItem("mb_chart_config", JSON.stringify(c)); } catch { /* noop */ }
  };
  return [config, update];
}

const OVERLAY_LABEL: Partial<Record<Overlay, string>> = {
  BB: "BOLL", DONCH: "DONCH", KELT: "KELT", SUPER: "SUPER", ICHI: "ICHI",
  PSAR: "PSAR", VWAP: "VWAP",
};

const OVERLAY_HINT: Partial<Record<Overlay, string>> = {
  SMA10: "10-period simple moving average",
  SMA20: "20-period simple moving average",
  SMA50: "50-period simple moving average",
  SMA100: "100-period simple moving average",
  SMA200: "200-period simple moving average",
  EMA9: "9-period exponential moving average",
  EMA21: "21-period exponential moving average",
  EMA50: "50-period exponential moving average",
  BB: "Bollinger Bands (20, 2σ)",
  DONCH: "Donchian channel (20) — the highest high and lowest low",
  KELT: "Keltner channel (EMA 20 ± 2 ATR)",
  SUPER: "Supertrend (10, 3) — flips side with the trend",
  ICHI: "Ichimoku: conversion, base and both spans. Spans are drawn where "
        + "they are computed, not displaced forward.",
  PSAR: "Parabolic SAR — drawn as dots, since the level jumps sides",
  VWAP: "Volume-weighted average price, cumulative over the window shown "
        + "(not an intraday session VWAP)",
};

export function ChartToolbar({
  config, onChange,
}: { config: ChartConfig; onChange: (c: ChartConfig) => void }) {
  const toggleOverlay = (o: Overlay) =>
    onChange({
      ...config,
      overlays: config.overlays.includes(o)
        ? config.overlays.filter((x) => x !== o)
        : [...config.overlays, o],
    });
  const Btn = ({ on, label, title, onClick }:
    { on: boolean; label: string; title?: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      title={title}
      className={`px-2 py-1 rounded text-[10.5px] tracking-wide border transition-colors ${
        on ? "border-amber text-amber bg-amber/10" : "border-line2 text-mut hover:text-txt"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-2">
      <span className="label-xs mr-1">Chart</span>
      <Btn on={config.type === "area"} label="AREA" onClick={() => onChange({ ...config, type: "area" })} />
      <Btn on={config.type === "candles"} label="CANDLES" onClick={() => onChange({ ...config, type: "candles" })} />
      <Btn on={config.type === "line"} label="LINE" onClick={() => onChange({ ...config, type: "line" })} />
      <span className="w-2" />

      {/* 15 overlays would be an unreadable row, so they're grouped and the
          groups collapse — the ones you're using stay visible. */}
      {OVERLAY_GROUPS.map(([group, list]) => (
        <span key={group} className="flex items-center gap-1.5">
          <span className="label-xs">{group}</span>
          {list.map((o) => (
            <Btn key={o} on={config.overlays.includes(o)}
                 label={OVERLAY_LABEL[o] ?? o}
                 title={OVERLAY_HINT[o]}
                 onClick={() => toggleOverlay(o)} />
          ))}
        </span>
      ))}

      {config.overlays.length > 0 && (
        <Btn on={false} label="CLEAR" title="Remove every overlay"
             onClick={() => onChange({ ...config, overlays: [] })} />
      )}

      <span className="w-2" />
      <span className="label-xs mr-1">Pane</span>
      {PANE_OPTIONS.map((p) => (
        <Btn key={p.id} on={config.pane === p.id} label={p.label} title={p.hint}
             onClick={() => onChange({
               ...config, pane: config.pane === p.id ? "none" : p.id,
             })} />
      ))}
      <span className="w-2" />
      <Btn on={config.volume} label="VOL" title="Volume bars"
           onClick={() => onChange({ ...config, volume: !config.volume })} />
      <Btn on={config.log} label="LOG" title="Logarithmic price scale"
           onClick={() => onChange({ ...config, log: !config.log })} />
    </div>
  );
}
