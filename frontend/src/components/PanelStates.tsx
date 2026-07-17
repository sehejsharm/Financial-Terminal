"use client";

/** Shared loading / error / empty presentation for data panels, so every
 *  tab looks and behaves the same (skeleton pulse, retry button, honest
 *  empty copy) instead of ad-hoc per page. */

export function PanelLoading({ label = "Loading…" }: { label?: string }) {
  return <div className="text-mut text-xs animate-pulse">{label}</div>;
}

export function PanelError({ error, retry, label }: {
  error: string; retry?: () => void; label?: string;
}) {
  return (
    <div className="panel-2 p-4 text-sm">
      <div className="text-red mb-2">{label ? `${label}: ` : ""}{error}</div>
      {retry && <button onClick={retry} className="btn-ghost text-xs">Retry</button>}
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
