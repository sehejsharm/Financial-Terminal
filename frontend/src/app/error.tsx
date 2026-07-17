"use client";

/** Route-level error boundary: a crash inside any page renders this panel
 *  (with recovery) instead of blanking the whole app. Next.js wires this up
 *  automatically for every route segment under app/. */
export default function RouteError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="panel-2 p-6 max-w-lg text-center">
        <div className="text-red text-sm font-bold uppercase tracking-wider mb-2">
          Something broke on this page
        </div>
        <div className="text-mut text-xs mb-4 break-words">
          {error?.message || "Unexpected error."}
          {error?.digest && <span className="block mt-1 opacity-60">ref {error.digest}</span>}
        </div>
        <div className="flex items-center justify-center gap-2">
          <button onClick={reset} className="btn-primary text-xs">Try again</button>
          <a href="/" className="btn-ghost text-xs">Back to dashboard</a>
        </div>
      </div>
    </div>
  );
}
