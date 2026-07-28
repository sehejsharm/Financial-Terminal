"use client";

import { GROUP_LABELS, groupedFunctions } from "@/lib/terminalFunctions";

/**
 * The function rail.
 *
 * Sixteen screens behind a <select> meant you had to open a dropdown to
 * remember what the terminal could even do. They're all visible here,
 * grouped, each showing the mnemonic you can type instead — which is how
 * anyone who uses this daily will actually navigate.
 */
export function FunctionRail({ active, onPick }: {
  active: string;
  onPick: (label: string) => void;
}) {
  return (
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
    </nav>
  );
}
