"use client";

import { useEffect, useState } from "react";

import { Markdown } from "@/components/Markdown";
import { api } from "@/lib/api";

type Mode = "bull-bear" | "deep";

/**
 * AI deep-dive. Calls are on-demand (button press) rather than on mount so we
 * don't burn the Groq/Gemini quota every time the user lands on the tab.
 */
export function AIPanel({ ticker }: { ticker: string }) {
  const [provider, setProvider] = useState<{ available: boolean; provider: string | null } | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setText(""); setMode(null); setErr(null);
    api.aiProvider().then(setProvider).catch(() => setProvider({ available: false, provider: null }));
  }, [ticker]);

  async function run(m: Mode) {
    setMode(m); setBusy(true); setErr(null); setText("");
    try {
      const r = m === "bull-bear" ? await api.bullBear(ticker) : await api.deepAnalysis(ticker);
      setText(r.markdown);
    } catch (e: any) {
      setErr(e?.detail || "AI request failed.");
    } finally {
      setBusy(false);
    }
  }

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
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}
