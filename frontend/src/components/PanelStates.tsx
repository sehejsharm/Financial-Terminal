"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Skel } from "@/components/ui";

/** Shared loading / error / empty presentation for data panels, so every
 *  tab looks and behaves the same (skeleton, retry button, honest empty
 *  copy) instead of ad-hoc per page. */

export function PanelLoading({ label = "Loading…", rows = 4 }:
  { label?: string; rows?: number }) {
  return (
    <div className="panel-2 p-4" role="status" aria-label={label}>
      <div className="text-mut text-[11px] mb-2.5 flex items-center gap-2">
        <span className="mb-ping w-1.5 h-1.5 rounded-full bg-amber inline-block" />
        {label}
      </div>
      {/* A shape where the content will be. A bare pulsing word tells you
          nothing about whether anything is coming. */}
      <div className="grid gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skel key={i} h={10} w={`${92 - i * 9}%`} />
        ))}
      </div>
    </div>
  );
}

export function PanelError({ error, retry, label, serverFault, action }: {
  error: string;
  retry?: () => void;
  label?: string;
  /** The backend failed, as opposed to the browser being offline. */
  serverFault?: boolean;
  /** An extra recovery the panel can offer (e.g. Regenerate). */
  action?: ReactNode;
}) {
  return (
    <div className="panel-2 p-4 text-sm">
      <div className="flex items-start gap-2 mb-2">
        <AlertTriangle size={14} className="text-red mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-red break-words">
            {label ? `${label}: ` : ""}{error}
          </div>
          {serverFault && (
            // Said explicitly because the old copy sent people to check a
            // connection that was working while the server returned 502.
            <div className="text-mut text-xs mt-1">
              This failed on the server, not on your connection.
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {retry && <button onClick={retry} className="btn-ghost text-xs">Retry</button>}
        {action}
      </div>
    </div>
  );
}

export function PanelEmpty({ children, retry }: {
  children: React.ReactNode; retry?: () => void;
}) {
  return (
    <div className="panel-2 p-4 text-mut text-sm flex items-center gap-3 flex-wrap">
      <span className="flex-1 min-w-0">{children}</span>
      {retry && <button onClick={retry} className="btn-ghost text-xs shrink-0">Retry</button>}
    </div>
  );
}
