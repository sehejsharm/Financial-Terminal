"use client";

import { ColorType, createChart, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";

type Candle = { time: string | number; close: number; open?: number; high?: number; low?: number };

/**
 * TradingView Lightweight Charts area chart. Reuses the terminal palette so
 * it visually matches the rest of the app.
 */
export function PriceChart({ data, height = 360 }: { data: Candle[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#dfe3ea",
        fontFamily: '"JetBrains Mono", monospace',
      },
      grid: { vertLines: { color: "#1c2129" }, horzLines: { color: "#1c2129" } },
      rightPriceScale: { borderColor: "#1c2129" },
      timeScale: { borderColor: "#1c2129", timeVisible: false },
      crosshair: { vertLine: { color: "#ffb000" }, horzLine: { color: "#ffb000" } },
    });
    const series = chart.addAreaSeries({
      lineColor: "#ffb000",
      topColor: "rgba(255,176,0,0.30)",
      bottomColor: "rgba(255,176,0,0.02)",
      lineWidth: 2,
      priceLineColor: "#ffb000",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !data?.length) return;
    const points = data
      .map((c) => {
        const t = typeof c.time === "string"
          ? Math.floor(new Date(c.time).getTime() / 1000)
          : Number(c.time);
        return { time: t as UTCTimestamp, value: Number(c.close ?? c.open ?? 0) };
      })
      .filter((p) => Number.isFinite(p.value) && p.value > 0);
    seriesRef.current.setData(points);
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  return <div ref={ref} style={{ height }} className="panel" />;
}
