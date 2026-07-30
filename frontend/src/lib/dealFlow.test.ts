import { describe, expect, it } from "vitest";

import {
  conviction, dealsNote, flowNote, insiderKind, insiderNote, labelFor, netSkew,
  ONE_SIDED_PCT, rankFlow, readFlow, summariseInsiders, type FlowRow,
} from "./dealFlow";

const flow = (over: Partial<FlowRow> = {}): FlowRow => ({
  symbol: "RELIANCE", deals: 4, participants: 3,
  buy_qty: 100_000, sell_qty: 20_000, net_qty: 80_000,
  net_value: 4_000_000_00, ...over,
});

describe("labelFor", () => {
  it("gives the deal columns readable names", () => {
    expect(labelFor("net_qty")).toBe("Net quantity");
    expect(labelFor("client_name")).toBe("Client");
  });

  it("still shows an unmapped column", () => {
    expect(labelFor("some_field")).toBe("Some field");
  });
});

describe("netSkew", () => {
  it("measures net against GROSS activity, not against nothing", () => {
    // The same net quantity is a lopsided week on small gross and noise on
    // large gross. Net alone cannot tell them apart.
    expect(netSkew(15_000, 5_000)).toBeCloseTo(50, 6);
    expect(netSkew(2_505_000, 2_495_000)).toBeCloseTo(0.2, 4);
  });

  it("is negative when selling dominates", () => {
    expect(netSkew(1, 3)!).toBeCloseTo(-50, 6);
  });

  it("stays inside ±100", () => {
    expect(netSkew(100, 0)).toBe(100);
    expect(netSkew(0, 100)).toBe(-100);
  });

  it("refuses rather than dividing by zero", () => {
    expect(netSkew(0, 0)).toBeNull();
  });
});

describe("conviction", () => {
  it("separates one decision from a pattern", () => {
    expect(conviction(1)).toBe("one participant");
    expect(conviction(3)).toBe("few");
    expect(conviction(12)).toBe("broad");
  });

  it("says unknown rather than guessing when undisclosed", () => {
    expect(conviction(null)).toBe("unknown");
    expect(conviction(undefined)).toBe("unknown");
    expect(conviction(0)).toBe("unknown");
  });
});

describe("readFlow", () => {
  it("calls a single-participant net buy one desk's decision", () => {
    // A ₹40cr net buy from one participant and from twelve rendered
    // identically before, and they are completely different information.
    const r = readFlow(flow({ participants: 1 }));
    expect(r.read).toMatch(/SINGLE participant/);
    expect(r.read).toMatch(/not a consensus/);
  });

  it("calls a broad net buy the closest thing to independent agreement", () => {
    const r = readFlow(flow({ participants: 14 }));
    expect(r.conviction).toBe("broad");
    expect(r.read).toMatch(/independent agreement/);
  });

  it("calls a balanced name a transfer, not accumulation", () => {
    const r = readFlow(flow({ buy_qty: 100_000, sell_qty: 98_000 }));
    expect(r.read).toMatch(/transfer between holders looks like rather than accumulation/);
  });

  it("says so when the participant count wasn't disclosed", () => {
    const r = readFlow(flow({ participants: null }));
    expect(r.read).toMatch(/participant count wasn't disclosed/);
  });

  it("warns that a few participants can be driven by one or two", () => {
    expect(readFlow(flow({ participants: 3 })).read)
      .toMatch(/one or two of them drive the whole figure/);
  });

  it("handles a row with no quantity at all", () => {
    const r = readFlow(flow({ buy_qty: 0, sell_qty: 0 }));
    expect(r.netSkewPct).toBeNull();
    expect(r.read).toMatch(/nothing to read/);
  });
});

describe("rankFlow", () => {
  it("EXCLUDES names whose buying and selling cancel", () => {
    // A ₹500cr name that nets to zero is a big transfer, not a big signal, and
    // ranking it first sends the reader to the least informative row.
    const ranked = rankFlow([
      flow({ symbol: "BALANCED", buy_qty: 1e6, sell_qty: 1e6, net_value: 5e10 }),
      flow({ symbol: "REAL", buy_qty: 1e6, sell_qty: 1e5, net_value: 1e9 }),
    ]);
    expect(ranked.map((r) => r.symbol)).toEqual(["REAL"]);
  });

  it("ranks the survivors by size of net value", () => {
    const ranked = rankFlow([
      flow({ symbol: "SMALL", buy_qty: 100, sell_qty: 0, net_value: 1e6 }),
      flow({ symbol: "BIG", buy_qty: 100, sell_qty: 0, net_value: 9e9 }),
    ]);
    expect(ranked.map((r) => r.symbol)).toEqual(["BIG", "SMALL"]);
  });

  it("ranks a big net SELL as highly as a big net buy", () => {
    const ranked = rankFlow([
      flow({ symbol: "BUY", buy_qty: 100, sell_qty: 0, net_value: 1e9 }),
      flow({ symbol: "SELL", buy_qty: 0, sell_qty: 100, net_value: -9e9 }),
    ]);
    expect(ranked[0].symbol).toBe("SELL");
  });

  it("uses a threshold that can be moved", () => {
    const rows = [flow({ buy_qty: 55, sell_qty: 45 })];   // 10% skew
    expect(rankFlow(rows)).toHaveLength(0);
    expect(rankFlow(rows, 5)).toHaveLength(1);
    expect(ONE_SIDED_PCT).toBe(20);
  });
});

describe("flowNote", () => {
  const rows = [
    flow({ symbol: "A", buy_qty: 1e6, sell_qty: 1e5, participants: 1 }),
    flow({ symbol: "B", buy_qty: 1e6, sell_qty: 9.8e5, participants: 6 }),
  ];

  it("says how many names are genuinely one-sided", () => {
    const note = flowNote(rows, rankFlow(rows), "2026-06-01", "2026-06-30");
    expect(note).toMatch(/1 of them are genuinely one-sided/);
    expect(note).toMatch(/transfer between holders rather than accumulation/);
  });

  it("counts the single-participant names separately", () => {
    expect(flowNote(rows, rankFlow(rows), null, null))
      .toMatch(/1 of the one-sided names involve a SINGLE participant/);
  });

  it("says disclosure is triggered by SIZE, not conviction", () => {
    const note = flowNote(rows, rankFlow(rows), null, null);
    expect(note).toMatch(/a SIZE threshold, not a conviction one/);
    expect(note).toMatch(/willing party on the other side/);
    expect(note).toMatch(/price has already moved by the time you read it/);
  });

  it("states the window when it knows it", () => {
    expect(flowNote(rows, rankFlow(rows), "2026-06-01", "2026-06-30"))
      .toMatch(/between 2026-06-01 and 2026-06-30/);
  });

  it("says so with no activity", () => {
    expect(flowNote([], [], null, null)).toMatch(/No bulk-deal activity/);
  });
});

describe("insiderKind", () => {
  it("separates an ESOP allotment from an open-market buy", () => {
    // The misreading this prevents: counting compensation as conviction.
    expect(insiderKind("ESOP allotment")).toBe("allotment");
    expect(insiderKind("Acquisition", "ESOP exercise")).toBe("allotment");
    expect(insiderKind("Market purchase")).toBe("open-market buy");
  });

  it("recognises sales", () => {
    expect(insiderKind("Sale")).toBe("open-market sell");
    expect(insiderKind("Disposal", "Open market")).toBe("open-market sell");
  });

  it("recognises pledges, which are neither a buy nor a sell", () => {
    expect(insiderKind("Pledge creation")).toBe("pledge");
    expect(insiderKind("Revocation of pledge")).toBe("pledge");
  });

  it("recognises gifts and off-market transfers", () => {
    expect(insiderKind("Gift")).toBe("gift or transfer");
    expect(insiderKind("Acquisition", "Inter-se transfer")).toBe("gift or transfer");
  });

  it("says other rather than guessing", () => {
    expect(insiderKind(null)).toBe("other");
    expect(insiderKind("")).toBe("other");
    expect(insiderKind("Something unrecognised")).toBe("other");
  });
});

describe("summariseInsiders", () => {
  const rows = [
    { type: "Market purchase" }, { type: "Market purchase" },
    { type: "Sale" },
    { type: "ESOP allotment" }, { type: "ESOP allotment" }, { type: "ESOP allotment" },
    { type: "Pledge creation" },
    { type: "Mystery" },
  ];

  it("keeps allotments OUT of the buy count", () => {
    const s = summariseInsiders(rows);
    expect(s.buys).toBe(2);
    expect(s.allotments).toBe(3);
    // Net decisions counts only genuine choices to transact.
    expect(s.netDecisions).toBe(1);
  });

  it("counts every row exactly once", () => {
    const s = summariseInsiders(rows);
    expect(s.buys + s.sells + s.allotments + s.pledges + s.other).toBe(s.total);
  });

  it("handles an empty list", () => {
    expect(summariseInsiders([]).total).toBe(0);
  });
});

describe("insiderNote", () => {
  const s = summariseInsiders([
    { type: "Market purchase" }, { type: "Sale" },
    { type: "ESOP allotment" }, { type: "Pledge creation" },
  ]);

  it("explains why allotments are counted separately", () => {
    expect(insiderNote(s)).toMatch(/compensation being issued/);
    expect(insiderNote(s)).toMatch(/manufactures an “insiders are buying” signal out of payroll/);
  });

  it("explains what a pledge says and doesn't say", () => {
    expect(insiderNote(s)).toMatch(/promoter borrowing against stock/);
    expect(insiderNote(s)).toMatch(/rather than their view of the company/);
  });

  it("says sales carry less information than buys", () => {
    expect(insiderNote(s)).toMatch(/sales carry much less information than buys/);
  });

  it("gets the grammar right in the singular", () => {
    expect(insiderNote(summariseInsiders([{ type: "Market purchase" }])))
      .toMatch(/1 open-market buy/);
  });

  it("says so when there is nothing", () => {
    expect(insiderNote(summariseInsiders([]))).toMatch(/No insider disclosures/);
  });
});

describe("dealsNote", () => {
  it("explains what a bulk deal is", () => {
    expect(dealsNote("bulk", 12)).toMatch(/above 0\.5% of a company's listed shares/);
  });

  it("explains what a block deal is, which is different", () => {
    expect(dealsNote("block", 3)).toMatch(/single negotiated trade of at least ₹10 crore/);
  });

  it("says these are a record of who moved, not a trade to follow", () => {
    const note = dealsNote("bulk", 5);
    expect(note).toMatch(/triggered by SIZE, not by conviction/);
    expect(note).toMatch(/a record of who moved, not a trade to follow/);
  });

  it("gets the grammar right for one deal", () => {
    expect(dealsNote("block", 1)).toMatch(/1 disclosed block deal\./);
  });
});
