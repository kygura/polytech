import { describe, expect, it } from "vitest";
import { MODES, stopLabel } from "./autopilot";

describe("autopilot header words", () => {
  it("names every level in plain words", () => {
    expect(Object.values(MODES).map((m) => m.short)).toEqual(["Off", "Paper", "Asks you", "Small trades", "Full"]);
  });
  it("the stop button hides when there is nothing to stop, and says what it will do otherwise", () => {
    expect(stopLabel("L0", 0, false)).toBeNull();
    expect(stopLabel("L0", 2, false)).toBe("Cancel 2 orders");
    expect(stopLabel("L3", 0, false)).toBe("Stop autopilot");
    expect(stopLabel("L3", 1, false)).toBe("Stop · cancel 1 order");
    expect(stopLabel("L3", 1, true)).toBe("Confirm: stop and cancel 1 order");
  });
});
