import { describe, expect, it } from "vitest";
import { refitConfirm, refitDelta, refitPayload } from "./refit";

const s = { extremize: 1.12, n: 34, at: "2026-10-19T00:00:00Z" };

describe("refit card", () => {
  it("apply writes extremize and clears suggested in one body; dismiss only clears", () => {
    expect(refitPayload("apply", s)).toEqual({ extremize: 1.12, suggested: null });
    expect(refitPayload("dismiss", s)).toEqual({ suggested: null });
    expect("extremize" in refitPayload("dismiss", s)).toBe(false);
  });
  it("delta is signed to 2 dp; confirm text repeats the value", () => {
    expect(refitDelta(1, s)).toBe("+0.12");
    expect(refitDelta(1.2, s)).toBe("−0.08");
    expect(refitConfirm(s)).toBe("Apply extremize 1.12? Future p̂ blends use it; past journal rows are not rewritten.");
  });
});
