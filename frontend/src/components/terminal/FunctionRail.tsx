"use client";

import { useEffect, useState } from "react";
import { HelpCircle, X } from "lucide-react";

import { GROUP_LABELS, groupedFunctions } from "@/lib/terminalFunctions";

/**
 * The function rail.
 *
 * Sixteen screens behind a <select> meant you had to open a dropdown to
 * remember what the terminal could even do. They're all visible here,
 * grouped, each showing the mnemonic you can type instead — which is how
 * anyone who uses this daily will actually navigate.
 *
 * The mnemonics are the one genuinely unlearnable thing in this app: "DES"
 * and "OMON" mean nothing to someone who has never sat in front of a
 * Bloomberg. So the first visit gets an explanation, once, and after that a
 * "?" brings it back — nothing permanent taking up space for the people who
 * already type FA without looking.
 */

const SEEN_KEY = "mb_seen_fn_intro";

function Guide({ onClose, firstRun }: { onClose: () => void; firstRun: boolean }) {
  return (
    <div className="hud mb-3 p-3.5 relative mb-rise">
      <button onClick={onClose} aria-label="Close the function guide"
              className="absolute top-2 right-2 text-mut hover:text-amber">
        <X size={14} />
      </button>
      <div className="heading mb-2">Function codes</div>
      <div className="text-xs text-mut leading-relaxed max-w-3xl mb-3">
        Each button below is a <strong className="text-txt">screen</strong>,
        labelled with the short code you can type instead of clicking. This is
        the Bloomberg convention: the code is faster than the menu once you
        know it, and you never have to learn it — clicking works identically.
        <br />
        Type a code in the command box and press{" "}
        <kbd className="px-1 border border-line2 rounded">⏎</kbd> (
        <span className="text-amber num">FA</span> for financials), or type a
        symbol and a code together (
        <span className="text-amber num">TCS.NS OMON</span>). Press{" "}
        <kbd className="px-1 border border-line2 rounded">[</kbd> and{" "}
        <kbd className="px-1 border border-line2 rounded">]</kbd> to cycle
        screens, and <kbd className="px-1 border border-line2 rounded">/</kbd>{" "}
        to jump to the command box.
      </div>

      <div className="grid gap-3"
           style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {groupedFunctions().map(([group, list]) => (
          <div key={group}>
            <div className="label-xs mb-1.5">{GROUP_LABELS[group]}</div>
            <div className="grid gap-1">
              {list.map((f) => (
                <div key={f.label} className="flex items-baseline gap-2 text-[11px] min-w-0">
                  <span className="num text-amber w-11 shrink-0">{f.code}</span>
                  <span className="text-txt shrink-0">{f.label}</span>
                  <span className="text-mut truncate" title={f.hint}>— {f.hint}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {firstRun && (
        <button onClick={onClose} className="btn-primary text-xs mt-3">Got it</button>
      )}
    </div>
  );
}

export function FunctionRail({ active, onPick }: {
  active: string;
  onPick: (label: string) => void;
}) {
  // `null` while unknown: rendering the guide and then hiding it on mount
  // would flash it at every returning user.
  const [seen, setSeen] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setSeen(localStorage.getItem(SEEN_KEY) === "1");
    } catch {
      setSeen(true);      // storage blocked: don't nag on every page view
    }
  }, []);

  function dismiss() {
    setOpen(false);
    setSeen(true);
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
  }

  const showGuide = open || seen === false;

  return (
    <>
      {showGuide && <Guide onClose={dismiss} firstRun={seen === false} />}

      <nav className="hud mb-4 px-2 py-2 flex flex-wrap items-center gap-x-4 gap-y-2"
           aria-label="Terminal functions">
        {groupedFunctions().map(([group, list]) => (
          <div key={group} className="flex items-center gap-1.5">
            <span className="label-xs whitespace-nowrap pr-0.5 hidden lg:inline">
              {GROUP_LABELS[group]}
            </span>
            {list.map((f) => {
              const on = f.label === active;
              return (
                <button
                  key={f.label}
                  onClick={() => onPick(f.label)}
                  aria-current={on ? "page" : undefined}
                  title={`${f.label} — ${f.hint}. Type "${f.code}" in the command box to jump here.`}
                  className={`px-2 py-1 rounded text-[11px] tracking-wider font-bold border transition-colors ${
                    on
                      ? "border-amber text-amber bg-amber/10"
                      : "border-line2 text-mut hover:text-txt hover:border-mut"
                  }`}
                >
                  {f.code}
                </button>
              );
            })}
          </div>
        ))}

        <div className="flex-1" />
        {/* The active function spelled out — the codes are terse by design, so
            the current one always reads in full somewhere. */}
        <span className="text-[11px] text-txt whitespace-nowrap pr-1">{active}</span>
        <button onClick={() => setOpen((o) => !o)}
                aria-expanded={showGuide}
                aria-label="What do these codes mean?"
                title="What do these codes mean?"
                className="text-mut hover:text-amber shrink-0">
          <HelpCircle size={14} />
        </button>
      </nav>
    </>
  );
}
