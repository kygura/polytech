import { describe, expect, it } from "vitest";
import { changeLabel, daysLabel, emptyCopy, isMarketId, listUrl, staleRow, volLabel, wideRow } from "./marketList";

const NOW = Date.parse("2026-10-20T12:00:00Z");

describe("market list helpers", () => {
  it("builds one all-markets request: text and category in a JSON filter, never in the DSL", () => {
    const u = new URL(`http://x${listUrl(' fed cat:politics "', "politics")}`);
    expect(u.searchParams.get("watchFirst")).toBe("1");
    expect(JSON.parse(u.searchParams.get("filter")!)).toEqual({ text: 'fed cat:politics "', categories: ["politics"], muted: false, sort: [{ field: "volume24h", dir: "desc" }], limit: 200 });
    expect(JSON.parse(new URL(`http://x${listUrl("", null)}`).searchParams.get("filter")!)).toEqual({ muted: false, sort: [{ field: "volume24h", dir: "desc" }], limit: 200 });
  });
  it("days, signed change, volume", () => {
    expect(daysLabel("2026-10-25T12:00:00Z", NOW)).toBe("5d");
    expect(daysLabel("2026-10-20T20:00:00Z", NOW)).toBe("<1d");
    expect(daysLabel("2026-10-19T12:00:00Z", NOW)).toBe("ended");
    expect(daysLabel(null, NOW)).toBe("—");
    expect(changeLabel(0.54)).toEqual({ text: "+0.5", dir: "up" });
    expect(changeLabel(-1.23)).toEqual({ text: "−1.2", dir: "down" });
    expect(changeLabel(0.01)).toEqual({ text: "0.0", dir: "flat" });
    expect(changeLabel(null)).toEqual({ text: "—", dir: "none" });
    expect(volLabel(170)).toBe("$170");
    expect(volLabel(null)).toBeNull();
  });
  it("stale rows (> 6 h or never) and wide books", () => {
    expect(staleRow({ ts: "2026-10-20T05:00:00Z" }, NOW)).toBe(true);
    expect(staleRow({ ts: "2026-10-20T11:00:00Z" }, NOW)).toBe(false);
    expect(staleRow({ ts: null }, NOW)).toBe(true);
    expect(wideRow({ bestBid: 0.01, bestAsk: 0.82 })).toBe(true);
    expect(wideRow({ bestBid: 0.4, bestAsk: 0.42 })).toBe(false);
    expect(wideRow({ bestBid: null, bestAsk: 0.42 })).toBe(false);
  });
  it("empty state says no match for a name search, not 'no theses'", () => {
    expect(emptyCopy("fed", null)).toBe('No market matches "fed".');
    expect(emptyCopy("fed", "politics")).toBe('No market matches "fed" in politics.');
    expect(emptyCopy("", "sports")).toBe("No markets in sports.");
    expect(emptyCopy("  ", null)).toMatch(/No tracked markets/);
    expect(emptyCopy("fed", null)).not.toMatch(/thes/i);
  });
  it("only 0x-hex ids are markets", () => {
    expect(isMarketId("0x47b8bcb7c24f67053d0c1201f1b3ba46db0dcff3b9b7fc26319054d48f6206af")).toBe(true);
    expect(isMarketId("0xAB12")).toBe(true);
    for (const bad of ["autonomy", "", "0x", "0xzz", "123", "0x12/../x"]) expect(isMarketId(bad)).toBe(false);
  });
});
