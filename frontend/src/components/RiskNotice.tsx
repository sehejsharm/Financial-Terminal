/** Risk notices for the surfaces that produce opinions or projections.
 *
 *  The app-wide disclaimer in Disclaimer.tsx covers the general case: market
 *  risk, and that this is a research tool rather than advice. It is shown on
 *  every page from the shell so no screen can be missing it.
 *
 *  These are different. Three surfaces here produce output that LOOKS like a
 *  conclusion — a machine-written bull/bear case, a backtest equity curve, an
 *  options payoff — and a general footer at the bottom of the page does not
 *  attach to any of them. A reader who has just watched a strategy return 40%
 *  on a chart needs the caveat next to the chart, not in the footer.
 *
 *  SCOPE NOTE, because this file started larger. It began with variants for
 *  backtests, derivatives and screens too, and those were wrong to add:
 *
 *  - The Backtester and OptionBuilder already carry long, specific footnotes
 *    about their own limitations. A second boxed warning saying roughly the
 *    same thing is noise, and it dilutes footnotes that are better written
 *    than a generic notice could be. What those two were actually missing was
 *    substance, not a box, so the missing sentences were added to the existing
 *    footnotes in their own voice instead.
 *  - The backtest variant also claimed the simulation ignores trading costs.
 *    It does not: Backtester takes a costBps parameter and applies it. Shipping
 *    that would have been a false statement about our own product, in a
 *    disclaimer, which is the worst place to put one.
 *
 *  So this is left with the one surface that genuinely had nothing attached to
 *  its output.
 */

import { AlertTriangle } from "lucide-react";

export type RiskVariant = "ai";

const NOTICES: Record<RiskVariant, { title: string; body: React.ReactNode }> = {
  ai: {
    title: "Machine-generated, not research",
    body: (
      <>
        This text is produced by a language model from the figures shown on
        this page. It is not a research report, not a recommendation, and has
        not been reviewed by an analyst. Language models state things
        confidently whether or not they are correct — treat every claim as
        something to verify against the filing, not as a finding.
      </>
    ),
  },
};

export function RiskNotice({ variant, className = "" }: {
  variant: RiskVariant;
  className?: string;
}) {
  const notice = NOTICES[variant];
  return (
    // role="note" rather than "alert": an alert interrupts a screen reader
    // mid-task, and this is standing context, not a change the user needs to
    // know about right now.
    <aside
      role="note"
      aria-label={notice.title}
      className={`mt-3 border-l-2 border-line2 pl-3 py-1 text-[11px] `
        + `leading-relaxed text-mut ${className}`}
    >
      <div className="flex items-center gap-1.5 text-txt/80 font-medium mb-0.5">
        <AlertTriangle size={11} aria-hidden className="shrink-0" />
        {notice.title}
      </div>
      <p>{notice.body}</p>
    </aside>
  );
}
