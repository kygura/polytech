import { describe, expect, it } from "vitest";
import { isTerminal } from "./terminalPath";

describe("isTerminal", () => {
  it("matches /trade and /trade/<id> only", () => {
    expect(["/trade", "/trade/", "/trade/0xabc"].map(isTerminal)).toEqual([true, true, true]);
    expect(["/trade/autonomy", "/trade/autonomy/x", "/trademark", "/trade-x", "/trade/a/b", "/watchlist"].map(isTerminal)).toEqual([false, false, false, false, false, false]);
  });
});
