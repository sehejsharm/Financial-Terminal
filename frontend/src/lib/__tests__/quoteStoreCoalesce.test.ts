/** The seed coalescer: many subscriptions, one request.
 *
 *  Measured before this existed: a dashboard load issued 40 calls to
 *  /market/quote-bulk, each carrying exactly one symbol — through an endpoint
 *  named bulk.
 *
 *  The cause was effect ordering, not a missing batch API. The page already
 *  bulk-subscribes via useQuotes(allSymbols), which would seed in one request.
 *  But React commits child effects before parent effects, so all 41 tiles run
 *  their own useQuote(symbol) first; by the time the page-level subscription
 *  runs, every refcount is already 1, nothing is "fresh", and the one-request
 *  path never executes. Fighting that ordering from the component tree is
 *  fragile, so the store buffers instead: whoever asks, however they ask, the
 *  requests merge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];

vi.mock("@/lib/api", () => ({
  api: {
    quoteBulk: vi.fn(async (syms: string[]) => {
      calls.push([...syms]);
      return Object.fromEntries(syms.map((s) => [s, {
        symbol: s, price: 100, prev_close: 99, change_pct: 1, currency: "INR",
      }]));
    }),
  },
  token: { get: () => null, set: () => {}, clear: () => {} },
  // The store now awaits this before opening a socket (the access token is
  // short-lived and held in memory). Mocked even though this environment has
  // no `window` and so never connects — a mock that omits an import the
  // module actually uses passes for the wrong reason and stops matching the
  // real module.
  ensureToken: async () => null,
}));

/** Let the coalescing window (50ms) elapse and the fetch resolve. */
const settle = () => new Promise((r) => setTimeout(r, 140));

async function freshStore() {
  vi.resetModules();
  calls.length = 0;
  const mod = await import("@/lib/quoteStore");
  return mod.quoteStore;
}

beforeEach(() => { calls.length = 0; });

describe("seed coalescing", () => {
  it("merges 41 separate single-symbol subscriptions into ONE request", async () => {
    const store = await freshStore();
    const syms = Array.from({ length: 41 }, (_, i) => `SYM${i}.NS`);

    // Exactly what the tile tree does: one subscribe() per cell, same tick.
    const unsubs = syms.map((s) => store.subscribe([s]));
    await settle();

    expect(calls.length, `issued ${calls.length} requests`).toBe(1);
    expect(calls[0]).toHaveLength(41);
    expect(new Set(calls[0])).toEqual(new Set(syms));
    unsubs.forEach((u) => u());
  });

  it("merges a per-cell burst with a later page-level bulk subscribe", async () => {
    // The real sequence: children first, parent second.
    const store = await freshStore();
    const syms = ["A.NS", "B.NS", "C.NS"];
    const unsubs = syms.map((s) => store.subscribe([s]));
    const bulk = store.subscribe(syms);          // parent effect, same tick
    await settle();

    expect(calls.length).toBe(1);
    expect(new Set(calls[0])).toEqual(new Set(syms));
    unsubs.forEach((u) => u()); bulk();
  });

  it("does not request a symbol it already holds a value for", async () => {
    const store = await freshStore();
    const a = store.subscribe(["A.NS"]);
    await settle();
    expect(calls.length).toBe(1);

    const b = store.subscribe(["A.NS"]);         // already seeded
    await settle();
    expect(calls.length, "re-requested a symbol already in the store").toBe(1);
    a(); b();
  });

  it("still seeds symbols that arrive after the window closed", async () => {
    // Coalescing must not mean "first batch wins and the rest never load".
    const store = await freshStore();
    const first = store.subscribe(["A.NS"]);
    await settle();
    const second = store.subscribe(["B.NS"]);
    await settle();

    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual(["A.NS"]);
    expect(calls[1]).toEqual(["B.NS"]);
    first(); second();
  });

  it("chunks past the server cap rather than letting it truncate", async () => {
    // The server refuses an oversized list; silently dropping the tail would
    // leave cells blank with nothing to explain why.
    const store = await freshStore();
    const syms = Array.from({ length: 250 }, (_, i) => `S${i}.NS`);
    const unsubs = syms.map((s) => store.subscribe([s]));
    await new Promise((r) => setTimeout(r, 400));

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(100);
    expect(calls.flat().length).toBe(250);       // nothing lost
    unsubs.forEach((u) => u());
  });

  it("survives a failing request without losing the subscription", async () => {
    const store = await freshStore();
    const { api } = await import("@/lib/api");
    (api.quoteBulk as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network"));

    const u = store.subscribe(["A.NS"]);
    await settle();                               // must not throw
    expect(store.getTick("A.NS")).toBeUndefined();
    u();
  });
});
