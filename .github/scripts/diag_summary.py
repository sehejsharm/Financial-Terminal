"""Reduce a /diag response to one reachable/failing line per provider.

Used by .github/workflows/healthcheck.yml. The point is to NOT print the raw
body: /diag reports which provider API keys are configured and includes up to
200 characters of raw upstream exception text, which can carry request URLs and
provider detail. Workflow logs are readable by anyone with repo access, which
is a wider audience than the endpoint itself now has.

Exits non-zero if any provider is failing, so the run goes red — that is the
whole reason the probe exists.
"""
from __future__ import annotations

import json
import sys

providers = json.load(sys.stdin).get("providers", {})
failing = []
for name, p in sorted(providers.items()):
    ok = bool(p.get("ok"))
    configured = p.get("configured")
    # A provider with no key is not a fault — it is a deliberate omission.
    if not ok and configured is False:
        print(f"{name}: not configured")
        continue
    print(f"{name}: {'ok' if ok else 'FAILING'}")
    if not ok:
        failing.append(name)

if failing:
    print(f"\n{len(failing)} provider(s) unreachable: {', '.join(failing)}",
          file=sys.stderr)
    sys.exit(1)
