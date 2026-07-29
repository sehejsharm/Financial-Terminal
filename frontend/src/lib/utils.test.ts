import { describe, expect, it } from "vitest";

import { humanNumber } from "./utils";


describe("humanNumber", () => {
  it("scales into the conventional units", () => {
    expect(humanNumber(1.5e12, "$")).toBe("$1.50T");
    expect(humanNumber(2.4e9, "$")).toBe("$2.40B");
    expect(humanNumber(9.9e6, "$")).toBe("$9.90M");
    expect(humanNumber(4_200, "$")).toBe("$4.20K");
  });

  it("steps UP rather than printing a mantissa of 1000", () => {
    // 999,999,999 formatted naively reads "$1000.00M" — a unit nobody uses,
    // and it looks like a bug sitting next to a "$1.00B" three rows above.
    expect(humanNumber(999_999_999, "$")).toBe("$1.00B");
    expect(humanNumber(999_999_999_999, "$")).toBe("$1.00T");
  });

  it("keeps the sign on the outside of the prefix", () => {
    expect(humanNumber(-2.4e9, "$")).toBe("-$2.40B");
  });

  it("renders small numbers plainly", () => {
    expect(humanNumber(42, "$")).toBe("$42");
  });

  it("shows a dash for nothing rather than a zero", () => {
    expect(humanNumber(null)).toBe("—");
    expect(humanNumber(undefined)).toBe("—");
    expect(humanNumber(Number.NaN)).toBe("—");
  });
});
