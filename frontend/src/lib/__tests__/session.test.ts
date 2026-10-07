// @vitest-environment jsdom

/** The client half of the session change.
 *
 *  The access token moved out of a script-readable cookie and into a module
 *  variable, with an HttpOnly refresh cookie behind it. Two properties matter
 *  enough to pin:
 *
 *  1. The token is NOT in document.cookie. That is the entire security benefit
 *     — a 12-hour JWT used to sit there for any XSS to read.
 *
 *  2. Refresh is SINGLE-FLIGHT. This is a correctness requirement, not an
 *     optimisation: the refresh token rotates on every use and the server
 *     treats a superseded token as evidence of theft and kills the session. A
 *     page load fires several requests at once, so without single-flight the
 *     first would rotate the cookie, the rest would present the old one, and
 *     the app would sign the user out for loading normally.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const REFRESH = "/api/v1/auth/refresh";

type FetchCall = { url: string; init: RequestInit };

function installFetch(handler: (c: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

function tokenResponse(tok: string, ttlMs = 15 * 60_000) {
  return new Response(JSON.stringify({
    access_token: tok,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    role: "user",
    csrf_token: "csrf-value",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function freshModule() {
  vi.resetModules();
  return import("@/lib/api");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "";
});

describe("the access token is never in a cookie", () => {
  it("setting it does not write document.cookie", async () => {
    const { token } = await freshModule();
    token.set("secret-access-token", new Date(Date.now() + 60_000).toISOString());
    expect(token.get()).toBe("secret-access-token");
    // The point of the whole exercise.
    expect(document.cookie).not.toContain("secret-access-token");
  });

  it("clearing it forgets the token", async () => {
    const { token } = await freshModule();
    token.set("x");
    token.clear();
    expect(token.get()).toBeNull();
  });

  it("the token does not survive a module reload, because it is in memory", async () => {
    const first = await freshModule();
    first.token.set("in-memory-only");
    const second = await freshModule();
    // A page reload is the real-world equivalent: nothing carries over, which
    // is why bootstrapSession has to ask the server.
    expect(second.token.get()).toBeNull();
  });
});

describe("refresh is single-flight", () => {
  it("concurrent callers share one network call", async () => {
    // The scenario that would otherwise sign the user out: several requests
    // starting at once on a fresh page.
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => { resolve = r; });
    const calls = installFetch(() => pending);

    const { ensureToken } = await freshModule();
    const all = Promise.all([ensureToken(), ensureToken(), ensureToken(),
                             ensureToken(), ensureToken(), ensureToken()]);
    resolve(tokenResponse("shared-token"));
    const results = await all;

    expect(calls.filter((c) => c.url.includes(REFRESH))).toHaveLength(1);
    expect(results.every((t) => t === "shared-token")).toBe(true);
  });

  it("a later call refreshes again once the first has finished", async () => {
    // Single-flight must not become refresh-once-ever.
    let n = 0;
    const calls = installFetch(() => tokenResponse(`token-${++n}`, -1));
    const { ensureToken } = await freshModule();
    await ensureToken();
    await ensureToken();
    expect(calls.filter((c) => c.url.includes(REFRESH))).toHaveLength(2);
  });

  it("does not refresh when the held token is still fresh", async () => {
    const calls = installFetch(() => tokenResponse("unused"));
    const { ensureToken, token } = await freshModule();
    token.set("still-good", new Date(Date.now() + 30 * 60_000).toISOString());
    expect(await ensureToken()).toBe("still-good");
    expect(calls).toHaveLength(0);
  });

  it("refreshes early, before the token actually expires", async () => {
    // A token that dies in flight produces a spurious 401. The skew is there
    // so a request never goes out holding one.
    const calls = installFetch(() => tokenResponse("renewed"));
    const { ensureToken, token } = await freshModule();
    token.set("nearly-dead", new Date(Date.now() + 10_000).toISOString());
    expect(await ensureToken()).toBe("renewed");
    expect(calls).toHaveLength(1);
  });
});

describe("refresh outcomes", () => {
  it("a 401 means there is no session", async () => {
    // bootstrapSession returns a three-state answer now, not a boolean — see
    // the "offline is not the same as signed out" block below for why.
    installFetch(() => new Response("{}", { status: 401 }));
    const { bootstrapSession, token } = await freshModule();
    expect(await bootstrapSession()).toBe("unauthenticated");
    expect(token.get()).toBeNull();
  });

  it("sends the CSRF header so the cookie endpoint accepts it", async () => {
    const calls = installFetch(() => tokenResponse("t"));
    const mod = await freshModule();
    mod.csrf.set("the-csrf-value");
    await mod.refreshSession();
    const hdrs = new Headers(calls[0].init.headers);
    expect(hdrs.get("X-CSRF-Token")).toBe("the-csrf-value");
  });

  it("sends cookies, since that is the only credential it has", async () => {
    const calls = installFetch(() => tokenResponse("t"));
    const { refreshSession } = await freshModule();
    await refreshSession();
    expect(calls[0].init.credentials).toBe("include");
  });

  it("calls the auth endpoint on THIS origin, not the API host", async () => {
    // Load-bearing: the app and the API are on different registrable
    // domains, so a cookie set by the API directly would be third-party and
    // never sent. next.config.js rewrites this path through this origin.
    const calls = installFetch(() => tokenResponse("t"));
    const { refreshSession } = await freshModule();
    await refreshSession();
    expect(calls[0].url).toBe(REFRESH);
    expect(calls[0].url).not.toMatch(/^https?:\/\//);
  });

  it("a network failure is not treated as a sign-out", async () => {
    // A dropped connection is not an authentication failure. Clearing the
    // token here would bounce someone to /login for a flaky tunnel.
    installFetch(() => { throw new TypeError("network down"); });
    const { refreshSession, token } = await freshModule();
    token.set("held", new Date(Date.now() + 60_000).toISOString());
    await refreshSession();
    expect(token.get()).toBe("held");
  });
});

describe("signing out", () => {
  it("tells the server, then forgets locally", async () => {
    const calls = installFetch(() => new Response(null, { status: 204 }));
    const { endSession, token } = await freshModule();
    token.set("x");
    await endSession();
    expect(calls[0].url).toContain("/api/v1/auth/logout");
    expect(token.get()).toBeNull();
  });

  it("forgets locally even if the server call fails", async () => {
    // Signing out of this browser matters more than the round trip.
    installFetch(() => { throw new TypeError("offline"); });
    const { endSession, token } = await freshModule();
    token.set("x");
    await endSession();
    expect(token.get()).toBeNull();
  });

  it("clears a legacy mb_token cookie left by an older build", async () => {
    installFetch(() => new Response(null, { status: 204 }));
    document.cookie = "mb_token=stale-jwt; path=/";
    const { endSession } = await freshModule();
    await endSession();
    expect(document.cookie).not.toContain("stale-jwt");
  });
});

describe("offline is not the same as signed out", () => {
  it("reports 'offline' when the server cannot be reached", async () => {
    // The mobile defect this exists for: an installed app opened with no
    // signal could not refresh, "false" meant "not signed in", and the gate
    // redirected to a login form that could not possibly succeed — throwing
    // away the user's context to show them a dead end.
    installFetch(() => { throw new TypeError("Failed to fetch"); });
    const { bootstrapSession } = await freshModule();
    expect(await bootstrapSession()).toBe("offline");
  });

  it("reports 'unauthenticated' when the server REFUSES", async () => {
    // A 401 is a real answer. This one should redirect.
    installFetch(() => new Response("{}", { status: 401 }));
    const { bootstrapSession } = await freshModule();
    expect(await bootstrapSession()).toBe("unauthenticated");
  });

  it("reports 'authenticated' on success", async () => {
    installFetch(() => tokenResponse("tok"));
    const { bootstrapSession } = await freshModule();
    expect(await bootstrapSession()).toBe("authenticated");
  });

  it("does not report offline after a later successful refresh", async () => {
    // The flag has to be reset, or one dropped connection would make the app
    // claim to be offline for the rest of the session.
    let fail = true;
    installFetch(() => {
      if (fail) throw new TypeError("Failed to fetch");
      return tokenResponse("tok");
    });
    const { bootstrapSession } = await freshModule();
    expect(await bootstrapSession()).toBe("offline");
    fail = false;
    expect(await bootstrapSession()).toBe("authenticated");
  });
});

describe("a broken server is not a refusal", () => {
  it("treats a 500 as offline, not as signed out", async () => {
    // A 5xx used to read as "unauthenticated", which redirected to /login —
    // so a brief API outage signed every user out and made them log in again.
    installFetch(() => new Response("Internal Server Error", { status: 500 }));
    const { bootstrapSession } = await freshModule();
    expect(await bootstrapSession()).toBe("offline");
  });

  it("does not throw away the held token on a 502", async () => {
    installFetch(() => new Response("Bad Gateway", { status: 502 }));
    const { refreshSession, token } = await freshModule();
    token.set("held", new Date(Date.now() + 60_000).toISOString());
    await refreshSession();
    expect(token.get()).toBe("held");
  });

  it("still treats a 401 as signed out", async () => {
    // The distinction has to cut both ways, or a genuinely revoked session
    // would keep pretending to be an outage forever.
    installFetch(() => new Response("{}", { status: 401 }));
    const { bootstrapSession, token } = await freshModule();
    expect(await bootstrapSession()).toBe("unauthenticated");
    expect(token.get()).toBeNull();
  });

  it("still treats a 403 as signed out", async () => {
    installFetch(() => new Response("{}", { status: 403 }));
    const { bootstrapSession } = await freshModule();
    expect(await bootstrapSession()).toBe("unauthenticated");
  });
});
