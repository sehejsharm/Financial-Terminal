"use client";

/** Per-account settings. Exists because passkey enrolment has to be reachable
 *  by every user, and the only account-ish surface before this was the admin
 *  page — which ordinary users cannot open. */

import { Shell } from "@/components/Shell";
import { PasskeyManager } from "@/components/PasskeyManager";

export default function AccountPage() {
  return (
    <Shell>
      <div className="max-w-2xl">
        <div className="text-sm font-semibold mb-3">Account & sign-in</div>
        <PasskeyManager />
      </div>
    </Shell>
  );
}
