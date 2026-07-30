"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { DataAge } from "@/components/DataAge";
import { Markdown } from "@/components/Markdown";
import { Methodology } from "@/components/Methodology";
import { PanelError, PanelLoading } from "@/components/PanelStates";
import { StatusBadge } from "@/components/StatusBadge";
import { Note, SectionHeader } from "@/components/ui";
import { api, type AIResp } from "@/lib/api";
import { groupInputs, inputCount, inputsNote, missingInputs } from "@/lib/aiInputs";
import { useAsync } from "@/lib/useAsync";

type Mode = "bull-bear" | "deep";

const MODES: ReadonlyArray<{ key: Mode; label: string; hint: string }> = [
  { key: "bull-bear", label: "Bull vs Bear",
    hint: "Both cases stated as strongly as the figures allow" },
  { key: "deep", label: "Deep analysis",
    hint: "A longer read across valuation, quality and balance sheet" },
];

/**
 * AI deep-dive. Calls are on-demand (button press) rather than on mount so we
 * don't burn the Groq/Gemini quota every time the user lands on the tab.
 *
 * The screen used to print the narrative and nothing else, which made it
 * unfalsifiable: a paragraph about margin compression reads identically whether
 * the model was handed a margin series, one figure, or nothing at all. So the
 * figures the model was actually given are now shown alongside it — including,
 * more importantly, the ones it did NOT have. A model with no margin will still
 * write a plausible paragraph about profitability, and naming the gap is the
 * only thing that lets a reader discount it.
 */
export function AIPanel({ ticker }: { ticker: string }) {
  // Probe failure is a transient network error, NOT "no provider" — keep the
  // two states distinguishable (PanelError + re-probe vs. the config copy).
  const { data: provider, error: probeErr, busy: probing, retry: reprobe } =
    useAsync(() => api.aiProvider(), []);

  const [mode, setMode] = useState<Mode | null>(null);
  const [resp, setResp] = useState<AIResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showInputs, setShowInputs] = useState(false);
  const [copied, setCopied] = useState(false);

  // Ticker at request time — a slow run() for a previous ticker must not
  // apply its result after the user switched.
  const tickerRef = useRef(ticker);
  tickerRef.current = ticker;

  useEffect(() => {
    setResp(null); setMode(null); setErr(null); setShowInputs(false);
  }, [ticker]);

  async function run(m: Mode) {
    const t = ticker;
    setMode(m); setBusy(true); setErr(null); setResp(null); setCopied(false);
    try {
      const r = m === "bull-bear" ? await api.bullBear(t) : await api.deepAnalysis(t);
      if (tickerRef.current !== t) return; // stale — ticker changed mid-flight
      setResp(r);
    } catch (e: any) {
      if (tickerRef.current !== t) return;
      setErr(e?.detail || "AI request failed.");
    } finally {
      if (tickerRef.current === t) setBusy(false);
    }
  }

  async function copy() {
    if (!resp?.markdown) return;
    try {
      await navigator.clipboard.writeText(resp.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied or an insecure context. The text is on
      // screen and selectable either way, so this stays silent.
    }
  }

  const groups = useMemo(() => groupInputs(resp?.inputs), [resp]);
  const missing = useMemo(() => missingInputs(resp?.inputs), [resp]);
  const nInputs = inputCount(resp?.inputs);

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
        {MODES.map((m) => (
          <button key={m.key} onClick={() => run(m.key)} disabled={busy}
                  title={m.hint}
                  className={`btn ${mode === m.key ? "btn-primary" : "btn-ghost"}`}>
            {m.label}
          </button>
        ))}
        {resp && !busy && (
          <button onClick={() => mode && run(mode)} className="btn btn-ghost"
                  title="Run it again — the model is not deterministic, and a
                         second run disagreeing with the first is information">
            Regenerate
          </button>
        )}
        <div className="flex-1" />
        {resp?.generated_at && <DataAge at={resp.generated_at} prefix="Generated" />}
        {provider?.provider && <span className="chip">via {provider.provider}</span>}
      </div>

      {busy && <PanelLoading label="Generating analysis…" rows={6} />}
      {err && !busy && <div className="text-red text-sm">{err}</div>}

      {!busy && !err && !resp && (
        <div className="panel-2 p-4">
          <div className="text-sm text-txt mb-1">Pick an analysis above.</div>
          <div className="text-xs text-mut leading-relaxed max-w-2xl">
            Output is written by a language model from the figures this app
            already holds, and those figures are shown alongside it so any claim
            can be checked against its input. It is educational, not investment
            advice.
          </div>
        </div>
      )}

      {resp && !busy && (
        <>
          <div className="panel-2 p-5">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <StatusBadge kind="ai" />
              <div className="flex-1" />
              <button onClick={copy} className="btn btn-ghost flex items-center gap-1.5 text-xs">
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy markdown"}
              </button>
            </div>
            <Markdown>{resp.markdown}</Markdown>
          </div>

          {/* What the model was told. The point of this section is that it
              makes the prose above checkable. */}
          <div className="mt-5">
            <SectionHeader
              title="What the model was given"
              count={nInputs ? `${nInputs} figures` : undefined}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {missing.length > 0 && (
                    <span className="text-[10.5px] text-amber/90 whitespace-nowrap">
                      {missing.length} expected figure{missing.length === 1 ? "" : "s"} missing
                    </span>
                  )}
                  {groups.length > 0 && (
                    <button onClick={() => setShowInputs((s) => !s)}
                            className="btn btn-ghost text-xs">
                      {showInputs ? "Hide figures" : "Show figures"}
                    </button>
                  )}
                </div>
              }
            />
            {showInputs && groups.length > 0 && (
              <div className="grid gap-2.5 mb-2.5"
                   style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                {groups.map((g) => (
                  <div key={g.group} className="hud p-3">
                    <div className="label-xs mb-2">{g.group}</div>
                    <div className="flex flex-col gap-1">
                      {g.rows.map((r) => (
                        <div key={r.key} className="flex items-baseline gap-2">
                          <span className="text-[11px] text-mut flex-1 min-w-0">{r.label}</span>
                          {/* Never truncated: a figure the reader can't read
                              is a figure they can't check the prose against. */}
                          <span className="num text-[11.5px] text-txt whitespace-nowrap">
                            {r.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {missing.length > 0 && (
              <div className="hud p-3 mb-2.5">
                <div className="label-xs mb-1.5 text-amber">Not supplied to the model</div>
                <div className="text-[11px] text-mut leading-relaxed">
                  {missing.join(" · ")}
                </div>
              </div>
            )}
            <Note>{inputsNote(resp.inputs)}</Note>
          </div>

          <Methodology id="aiAnalysis" className="mt-4" />
        </>
      )}
    </div>
  );
}
