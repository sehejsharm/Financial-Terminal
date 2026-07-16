"use client";

import { cn } from "@/lib/utils";

/** Shimmer placeholder block — replaces bare "Loading…" text states so each
 *  widget's final layout is visible while data arrives. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-panel2", className)} />;
}

/** A row of metric-card placeholders (dashboard / terminal snapshot grids). */
export function CardRowSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="panel-2 p-3.5">
          <Skeleton className="h-3 w-20 mb-2" />
          <Skeleton className="h-6 w-28" />
        </div>
      ))}
    </div>
  );
}

/** Terminal page while the header quote/snapshot resolve. */
export function TerminalSkeleton() {
  return (
    <div>
      <div className="panel-2 p-4 mb-5 flex items-center gap-5">
        <div className="flex-1">
          <Skeleton className="h-3 w-24 mb-2" />
          <Skeleton className="h-6 w-64 mb-2" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-16 w-40" />
      </div>
      <CardRowSkeleton />
      <CardRowSkeleton />
      <Skeleton className="h-[380px] w-full" />
    </div>
  );
}

/** List-row placeholders (movers panel, news lists). */
export function RowsSkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 px-2 py-1">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

/** Quant page while histories download + math runs. */
export function QuantSkeleton() {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6">
      <div>
        <Skeleton className="h-4 w-64 mb-3" />
        <Skeleton className="h-[320px] w-full" />
      </div>
      <div>
        <Skeleton className="h-4 w-40 mb-3" />
        <Skeleton className="h-[220px] w-full" />
      </div>
    </div>
  );
}
