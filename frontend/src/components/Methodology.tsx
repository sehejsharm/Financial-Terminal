"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FlaskConical } from "lucide-react";

import { METHODOLOGY, type MethodologyKey } from "@/lib/methodology";

/**
 * "Where does this number come from?", inline, on every computed figure.
 *
 * The app's most useful habit is already visible on the Volatility Cone and
 * Backtest screens: they say what the number assumes before you use it.
 * This makes that uniform. A collapsed one-line strip by default — a power
 * user reading their tenth WACC doesn't need the derivation again — opening
 * to the formula, the inputs, the assumptions and, most importantly, what
 * the model does not capture.
 *
 * The limits section is not optional and not softened. A model nobody can
 * see the edges of gets trusted past them.
 */

const KIND_LABEL = {
  computed: "Computed here",
  model: "Model output",
  ai: "AI-generated",
} as const;

const KIND_TONE = {
  computed: "text-mut border-line2",
  model: "text-amber border-amber/50",
  ai: "text-amber border-amber/60",
} as const;

export function Methodology({ id, className = "", defaultOpen = false }: {
  id: MethodologyKey;
  className?: string;
  defaultOpen?: boolean;
}) {
  const m = METHODOLOGY[id];
  const [open, setOpen] = useState(defaultOpen);
  if (!m) return null;

  return (
    <div className={`panel-2 ${className}`}>
      <button onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="w-full text-left px-3 py-2 flex items-center gap-2 flex-wrap">
        {open ? <ChevronDown size={12} className="text-mut shrink-0" />
              : <ChevronRight size={12} className="text-mut shrink-0" />}
        <FlaskConical size={11} className="text-amber shrink-0" />
        <span className="label-xs">Method &amp; assumptions</span>
        <span className={`text-[9px] uppercase tracking-[0.12em] px-1.5 py-0.5
                          rounded border shrink-0 ${KIND_TONE[m.kind]}`}>
          {KIND_LABEL[m.kind]}
        </span>
        <span className="text-[10.5px] text-mut flex-1 min-w-0 truncate">
          {m.what}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-line2 grid gap-3
                        text-[11px] leading-relaxed">
          <p className="text-txt">{m.what}</p>

          {m.formula && (
            <div>
              <div className="label-xs mb-1">Formula</div>
              <code className="num text-amber text-[11px] break-words">{m.formula}</code>
            </div>
          )}

          <Block title="Inputs" items={m.inputs} />
          <Block title="Assumptions" items={m.assumptions} />
          {/* Deliberately last and deliberately not softened: this is the
              part that tells you whether the number answers your question. */}
          <Block title="What this does NOT capture" items={m.limits} tone="text-amber" />
        </div>
      )}
    </div>
  );
}

function Block({ title, items, tone = "text-mut" }: {
  title: string; items: string[]; tone?: string;
}) {
  if (!items.length) return null;
  return (
    <div>
      <div className="label-xs mb-1">{title}</div>
      <ul className={`grid gap-1 ${tone}`}>
        {items.map((t, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-line2 shrink-0">—</span>
            <span className="min-w-0">{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
