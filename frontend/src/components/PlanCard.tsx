"use client";

/** The plan you are on, what it includes, and what you have spent today.
 *
 *  Deliberately not an upsell. It states the limits and the usage as facts,
 *  the way a bank statement does — no countdown, no "you're missing out", no
 *  red bar until you are actually at the limit. Someone who wants the paid
 *  tier will want it because the live feed is worth 499 rupees, not because a
 *  card nagged them.
 */

import { useEffect, useState } from "react";

import { api, type PlanState } from "@/lib/api";
import { planValue } from "@/lib/planDisplay";

const ENTITLEMENT_LABELS: Record<string, string> = {
  realtime_data: "Live prices",
  data_api: "Spreadsheet API (Excel, Sheets)",
  max_watchlists: "Watchlists",
  max_alerts: "Alerts",
  max_portfolios: "Portfolios",
  max_workspaces: "Saved workspaces",
  screens_per_day: "Screener runs per day",
  ai_per_day: "AI requests per day",
  history_years: "Years of history",
};

// The order things are shown in. Real-time first because it is the actual
// difference between the tiers; the countable limits after, because they are
// the thing people check when something is refused.
const ORDER = [
  "realtime_data", "data_api", "history_years",
  "max_watchlists", "max_alerts", "max_portfolios", "max_workspaces",
  "screens_per_day", "ai_per_day",
];

export function PlanCard() {
  const [state, setState] = useState<PlanState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.myPlan()
      .then((p) => { if (alive) setState(p); })
      .catch(() => {
        if (alive) setError("Could not load your plan. Retry in a moment.");
      });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="text-red text-xs">{error}</div>;
  if (!state) return <div className="text-xs text-mut">Loading your plan…</div>;

  const metered = Object.entries(state.usage);

  return (
    <div className="panel-2 p-4 flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{state.plan_name}</div>
          <div className="label-xs mt-0.5">
            {state.admin_override
              // Otherwise this screen tells the operator they are on a plan
              // they are not paying for.
              ? "Operator account — limits do not apply"
              : state.price_inr_month === 0
                ? "No charge"
                : `₹${state.price_inr_month} per month`}
          </div>
        </div>
      </div>

      {metered.length > 0 && !state.admin_override && (
        <div className="flex flex-col gap-2">
          <div className="label-xs">Used today</div>
          {metered.map(([key, u]) => {
            const capped = u.limit !== state.unlimited;
            const pct = capped && u.limit > 0
              ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0;
            const spent = capped && u.used >= u.limit;
            return (
              <div key={key} className="flex flex-col gap-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-mut">{ENTITLEMENT_LABELS[key] ?? key}</span>
                  <span className={spent ? "text-red" : "text-txt"}>
                    {u.used}{capped ? ` / ${u.limit}` : ""}
                  </span>
                </div>
                {capped && (
                  <div
                    className="h-1 bg-line2 rounded"
                    role="progressbar"
                    aria-valuenow={u.used}
                    aria-valuemin={0}
                    aria-valuemax={u.limit}
                    aria-label={ENTITLEMENT_LABELS[key] ?? key}
                  >
                    <div
                      className={`h-1 rounded ${spent ? "bg-red" : "bg-amber"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <div className="text-[10px] text-mut">
            Resets at midnight IST.
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="label-xs">Included</div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px]">
          {ORDER.filter((k) => k in state.entitlements).map((key) => (
            <div key={key} className="contents">
              <dt className="text-mut">{ENTITLEMENT_LABELS[key] ?? key}</dt>
              <dd className="text-right">
                {planValue(state.entitlements[key], state.unlimited)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {!state.admin_override && !state.entitlements.realtime_data && (
        <div className="border-t border-line2 pt-3 text-[11px] text-mut leading-relaxed">
          Prices on this plan are delayed. Everything else — fundamentals,
          screeners, the quant tools, your portfolio — uses the same data as
          the paid tier.
        </div>
      )}
    </div>
  );
}
