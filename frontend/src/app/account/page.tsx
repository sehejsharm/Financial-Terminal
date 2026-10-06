"use client";

/** Per-account settings: plan, sign-in methods, and active sessions.
 *
 *  Exists because passkey enrolment has to be reachable by every user, and the
 *  only account-ish surface before this was the admin page — which ordinary
 *  users cannot open. It now also carries the two things a user needs to be
 *  able to answer for themselves: what their plan allows, and what is signed
 *  in as them.
 */

import { Shell } from "@/components/Shell";
import { PasskeyManager } from "@/components/PasskeyManager";
import { PlanCard } from "@/components/PlanCard";
import { SessionManager } from "@/components/SessionManager";

export default function AccountPage() {
  return (
    <Shell>
      <div className="max-w-2xl flex flex-col gap-6">
        <section>
          <h2 className="text-sm font-semibold mb-3">Your plan</h2>
          <PlanCard />
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-3">Account &amp; sign-in</h2>
          <PasskeyManager />
        </section>

        <section>
          <SessionManager />
        </section>
      </div>
    </Shell>
  );
}
