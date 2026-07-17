"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Horizontal-scroll container with a visible affordance: when content
 * overflows to the right, a gradient fade + "scroll →" hint appear so the
 * clipped columns (e.g. a rightmost "Open →" action) aren't invisible.
 * The hint disappears once the user reaches the right edge.
 */
export function ScrollX({ children, className }: { children: React.ReactNode; className?: string }) {
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
      <div ref={ref} className={cn("overflow-x-auto", className)}>{children}</div>
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
