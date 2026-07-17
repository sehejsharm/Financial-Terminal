"use client";

import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/Markdown";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

type Mode = "bull-bear" | "deep";

/**
 * AI deep-dive. Calls are on-demand (button press) rather than on mount so we
 * don't burn the Groq/Gemini quota every time the user lands on the tab.
 */
export function AIPanel({ ticker }: { ticker: string }) {
  // Probe failure is a transient network error, NOT "no provider" — keep the
  // two states distinguishable (PanelError + re-probe vs. the config copy).
  const { data: provider, error: probeErr, busy: probing, retry: reprobe } =
    useAsync(() => api.aiProvider(), []);

  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Ticker at request time — a slow run() for a previous ticker must not
  // apply its result after the user switched.
  const tickerRef = useRef(ticker);
  tickerRef.current = ticker;

  useEffect(() => {
    setText(""); setMode(null); setErr(null);
  }, [ticker]);

  async function run(m: Mode) {
    const t = ticker;
    setMode(m); setBusy(true); setErr(null); setText("");
    try {
      const r = m === "bull-bear" ? await api.bullBear(t) : await api.deepAnalysis(t);
      if (tickerRef.current !== t) return; // stale — ticker changed mid-flight
      setText(r.markdown);
    } catch (e: any) {
      if (tickerRef.current !== t) return;
      setErr(e?.detail || "AI request failed.");
    } finally {
      if (tickerRef.current === t) setBusy(false);
    }
  }

  if (probing) return <PanelLoading label="Checking AI provider…" />;
  if (probeErr) return <PanelError error={probeErr} retry={reprobe} label="AI provider check failed" />;

  if (provider && !provider.available) {
    return (
      <div className="panel-2 p-4 text-mut text-sm">
        No AI provider configured. Set <code className="text-amber">GROQ_API_KEY</code> (or
        {" "}<code className="text-amber">GEMINI_API_KEY</code>) on the backend.
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={() => run("bull-bear")} disabled={busy} className={`btn ${mode === "bull-bear" ? "btn-primary" : "btn-ghost"}`}>
          Bull vs Bear
        </button>
        <button onClick={() => run("deep")} disabled={busy} className={`btn ${mode === "deep" ? "btn-primary" : "btn-ghost"}`}>
          Deep analysis
        </button>
        {provider?.provider && (
          <span className="chip ml-auto">via {provider.provider}</span>
        )}
      </div>

      {busy && <div className="text-mut text-xs animate-pulse">Generating analysis…</div>}
      {err && !busy && <div className="text-red text-sm">{err}</div>}
      {!busy && !err && !text && (
        <div className="panel-2 p-4 text-mut text-sm">
          Pick an analysis above. Output is AI-generated and educational — not investment advice.
        </div>
      )}
      {text && !busy && (
        <div className="panel-2 p-5">
          <div className="mb-3"><StatusBadge kind="ai" /></div>
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}
