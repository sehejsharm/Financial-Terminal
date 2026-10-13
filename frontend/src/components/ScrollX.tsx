"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Horizontal-scroll container with a visible affordance: when content
 * overflows to the right, a gradient fade + "scroll →" hint appear so the
 * clipped columns (e.g. a rightmost "Open →" action) aren't invisible.
 * The hint disappears once the user reaches the right edge.
 */
export function ScrollX({ children, className, label = "Scrollable table" }: {
  children: React.ReactNode; className?: string;
  /** Named for assistive tech. Override where "table" is not what it holds. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 8);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); };
  }, []);

  return (
    <div className="relative">
      {/* tabIndex, because arrow keys scroll the element that HAS FOCUS.
          Without it this container can only be scrolled with a pointer or a
          trackpad, so a keyboard user cannot reach the clipped columns at all
          — and the whole reason this component exists is that those columns
          are worth reaching (the gradient and the "scroll →" hint below are
          the same problem solved for sighted mouse users).

          axe calls it `scrollable-region-focusable`. It was a live CI failure
          on the workspace's financials widget, which renders through here, and
          it covers all 16 call sites at once because the fix belongs in the
          shared primitive rather than in each table.

          role + aria-label rather than a bare tabIndex: a focusable div with
          no role is a tab stop that announces nothing, which trades one defect
          for a more confusing one. */}
      <div ref={ref} tabIndex={0} role="region" aria-label={label}
           className={cn("overflow-x-auto", className)}>{children}</div>
      {more && (
        <>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-bg2 to-transparent" />
          <div className="pointer-events-none absolute bottom-1.5 right-2 text-[9px] uppercase tracking-wider text-amber bg-panel2/90 px-1.5 py-0.5 rounded border border-line">
            scroll →
          </div>
        </>
      )}
    </div>
  );
}
