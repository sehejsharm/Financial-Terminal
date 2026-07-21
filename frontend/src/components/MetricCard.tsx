import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Props = {
  label: string;
  // ReactNode so a streaming <LiveNumber> can slot straight into the value/
  // delta slots (string | number remain valid — they're ReactNodes too).
  value: ReactNode;
  delta?: ReactNode;
  tone?: "neutral" | "positive" | "negative";
  className?: string;
  /** Optional hover tooltip (native title) explaining methodology/source. */
  title?: string;
};

export function MetricCard({ label, value, delta, tone = "neutral", className, title }: Props) {
  const toneColor =
    tone === "positive" ? "text-green" : tone === "negative" ? "text-red" : "text-mut";
  return (
    <div title={title}
         className={cn("panel-2 p-3.5 flex flex-col gap-1 transition-colors hover:border-line2",
                       title && "cursor-help", className)}>
      <div className="label-xs">{label}</div>
      <div className="num text-xl text-white tracking-tight">{value ?? "—"}</div>
      {delta != null && <div className={cn("text-xs", toneColor)}>{delta}</div>}
    </div>
  );
}
