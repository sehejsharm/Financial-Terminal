"use client";

import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Shared page furniture.
 *
 * Every page had grown its own version of the same four things — a title
 * row, a section rule, a tab strip, an empty state — and they had drifted:
 * two tab idioms (underline on Quant, pill buttons on News and Macro), four
 * different bottom margins under headings, and empty states that ranged
 * from a styled panel to a bare grey sentence. None of that is a decision
 * anyone made; it's just where the code ended up.
 *
 * These are deliberately thin. They set spacing and type, and get out of
 * the way — a page that needs something different should still be able to
 * write its own markup rather than fight a prop.
 */

export function PageHeader({
  title, subtitle, actions, children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned controls — refresh, data age, mode toggles. */
  actions?: ReactNode;
  /** Controls that belong under the title (filters, country picker). */
  children?: ReactNode;
}) {
  return (
    <div className="mb-4">
      {/* flex-wrap + gap rather than justify-between: at mid viewports a
          button row set with justify-between wraps ONTO the heading. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h1 className="heading shrink-0">{title}</h1>
        <div className="flex-1 min-w-0" />
        {actions}
      </div>
      {subtitle && (
        <div className="text-mut text-xs mt-1.5 max-w-3xl leading-relaxed">{subtitle}</div>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function SectionHeader({
  title, count, actions, note,
}: {
  title: string;
  count?: number | string;
  actions?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="mb-2.5 pb-1.5 border-b border-line2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="heading">{title}</h2>
        {count != null && <span className="text-[10px] text-mut num">{count}</span>}
        <div className="flex-1" />
        {actions}
      </div>
      {note && <div className="text-[10.5px] text-mut mt-1 leading-relaxed">{note}</div>}
    </div>
  );
}

/** A section wrapper with consistent vertical rhythm. */
export function Section({
  title, count, actions, note, children,
}: {
  title: string; count?: number | string; actions?: ReactNode;
  note?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="mb-7">
      <SectionHeader title={title} count={count} actions={actions} note={note} />
      {children}
    </section>
  );
}

export type TabDef<T extends string> = { id: T; label: string; hint?: string };

/**
 * The app's one tab idiom: an underlined strip.
 *
 * Pill buttons read as actions ("do this now"); tabs are a view switch, and
 * the two were being used interchangeably. Anything that changes what you
 * are looking at is a tab.
 */
export function Tabs<T extends string>({
  tabs, value, onChange, className = "",
}: {
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist"
         className={`flex items-center gap-1 border-b border-line2 mb-4 overflow-x-auto ${className}`}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id}
                title={t.hint}
                onClick={() => onChange(t.id)}
                className={`px-3 py-2 text-xs uppercase tracking-wider border-b-2 -mb-px
                            whitespace-nowrap transition-colors ${
                  value === t.id
                    ? "border-amber text-amber"
                    : "border-transparent text-mut hover:text-txt"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Filter chips — a real multi-choice control, distinct from Tabs. */
export function ChipToggle({
  options, value, onChange,
}: {
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)}
                aria-pressed={value === o.id}
                className={`px-2.5 py-1 rounded text-[11px] uppercase tracking-wider border
                            transition-colors ${
                  value === o.id
                    ? "border-amber text-amber bg-amber/10"
                    : "border-line2 text-mut hover:text-txt hover:border-mut"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type Tone = "good" | "bad" | "neutral" | "warn";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-green", bad: "text-red", neutral: "text-txt", warn: "text-amber",
};

/** One number with its label — the unit of every scorecard in the app. */
export function Stat({
  label, value, sub, tone = "neutral", title, size = "md",
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  title?: string;
  size?: "sm" | "md" | "lg";
}) {
  const cls = size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-xl";
  return (
    <div className="hud mb-lift p-3.5 flex flex-col gap-1 min-w-0" title={title}>
      <div className="label-xs truncate">{label}</div>
      {/* Never truncated. A clipped number is worse than a wrapped one. */}
      <div className={`num ${cls} ${TONE_TEXT[tone]} leading-tight break-words`}>{value}</div>
      {sub && <div className="text-[10.5px] text-mut leading-relaxed">{sub}</div>}
    </div>
  );
}

/**
 * Hover/focus explainer.
 *
 * A `title` attribute can hold one sentence and can't be styled, reached by
 * keyboard reliably, or read on a touch screen. Anything that needs to
 * explain what a number MEANS — a status badge, a Bloomberg function code,
 * a model assumption — needs more room than that.
 */
export function InfoTip({
  children, title, body, align = "left", width = 280,
}: {
  children: ReactNode;
  title?: ReactNode;
  body: ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  return (
    <span className="relative inline-flex group/tip">
      <button type="button"
              className="inline-flex items-center gap-1 cursor-help text-left"
              // Focusable so the explanation is reachable without a mouse.
              aria-label={typeof title === "string" ? title : undefined}>
        {children}
      </button>
      <span role="tooltip"
            style={{ width }}
            className={`pointer-events-none absolute top-full mt-1.5 z-50 opacity-0
                        group-hover/tip:opacity-100 group-focus-within/tip:opacity-100
                        transition-opacity panel-2 shadow-panel p-2.5 max-w-[86vw]
                        ${align === "right" ? "right-0" : "left-0"}`}>
        {title && <span className="label-xs block mb-1">{title}</span>}
        <span className="block text-[11px] text-txt leading-relaxed">{body}</span>
      </span>
    </span>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10.5px] text-mut leading-relaxed max-w-4xl">{children}</div>
  );
}

export function Loading({ what = "data" }: { what?: string }) {
  return (
    <div className="panel-2 p-4 text-mut text-xs flex items-center gap-2">
      <span className="mb-ping w-1.5 h-1.5 rounded-full bg-amber inline-block" />
      Loading {what}…
    </div>
  );
}

export function EmptyState({
  title, detail, action,
}: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel-2 p-5">
      <div className="text-sm text-txt mb-1">{title}</div>
      {detail && <div className="text-xs text-mut leading-relaxed max-w-2xl">{detail}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Skeleton block — a shape where content will be, not a spinner. */
export function Skel({ h = 14, w = "100%", className = "" }:
  { h?: number; w?: number | string; className?: string }) {
  return (
    <span className={`mb-shimmer block rounded ${className}`}
          style={{ height: h, width: w }} aria-hidden />
  );
}

/** The loading shape of a grid of cards. */
export function SkeletonCards({ n = 6, rows = 3 }: { n?: number; rows?: number }) {
  return (
    <div className="grid gap-3"
         style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="hud p-3.5 flex flex-col gap-2">
          <Skel h={9} w="55%" />
          <Skel h={20} w="70%" />
          {Array.from({ length: rows - 2 }, (_, j) => <Skel key={j} h={8} w="85%" />)}
        </div>
      ))}
    </div>
  );
}

/**
 * The one way a panel renders its four states.
 *
 * Applied everywhere so no screen can invent a fifth — in particular, no
 * screen can render a spinner with no timeout behind it, which is how the
 * sector board came to hang indefinitely.
 */
export function AsyncPanel<T>({
  state, children, skeleton, emptyTitle, emptyDetail, isEmpty,
}: {
  state: {
    data: T | null; busy: boolean; error: string | null;
    serverFault?: boolean; retry: () => void;
  };
  children: (data: T) => ReactNode;
  skeleton?: ReactNode;
  emptyTitle?: string;
  emptyDetail?: ReactNode;
  isEmpty?: (data: T) => boolean;
}) {
  if (state.error) {
    return (
      <ErrorState
        message={state.error}
        onRetry={state.retry}
        hint={state.serverFault
          ? "This failed on the server, not on your connection."
          : undefined} />
    );
  }
  if (state.busy && state.data == null) return <>{skeleton ?? <SkeletonCards />}</>;
  if (state.data == null || (isEmpty?.(state.data) ?? false)) {
    return <EmptyState title={emptyTitle ?? "Nothing to show."} detail={emptyDetail} />;
  }
  return <>{children(state.data)}</>;
}

export function ErrorState({
  message, onRetry, hint,
}: { message: string; onRetry?: () => void; hint?: ReactNode }) {
  return (
    <div className="panel-2 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-red mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm text-red break-words">{message}</div>
          {hint && <div className="text-xs text-mut mt-1 leading-relaxed">{hint}</div>}
        </div>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="btn-ghost text-xs mt-3 flex items-center gap-1.5">
          <RefreshCw size={11} /> Retry
        </button>
      )}
    </div>
  );
}
