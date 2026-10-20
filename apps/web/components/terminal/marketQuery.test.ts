import { describe, expect, it } from "vitest";
import { parseQuery } from "@pm/core";
import { allQuery, daysShort, fromScreener, matchWatch, pc } from "./marketQuery";
import type { PublicWatchRow } from "../../lib/public";
import type { ScreenerRow } from "../screener/types";

describe("allQuery", () => {
  it("adds open-only, the list sort and a limit to free text", () => {
    const q = allQuery("fed rate", "-vol24h");
    expect(q).toBe("fed rate days:>0 sort:-vol24h limit:200");
    const { filter, errors } = parseQuery(q);
    expect(errors).toEqual([]);
    expect(filter.text).toBe("fed rate");
    expect(filter.sort).toEqual([{ field: "volume24h", dir: "desc" }]);
  });
  it("keeps the user's own sort, days and limit", () => {
    expect(allQuery("cat:politics sort:-liq days:<30 limit:20", "-vol24h")).toBe("cat:politics sort:-liq days:<30 limit:20");
  });
  it("every list sort parses", () => {
    for (const s of ["-vol24h", "-liq", "days", "-price"] as const) expect(parseQuery(allQuery("", s)).errors).toEqual([]);
  });
});

describe("rows", () => {
  const w = { conditionId: "0x1", question: "Will the Fed cut rates in December?", category: "Economy" } as PublicWatchRow;
  it("watch filter matches every word in question or category", () => {
    expect(matchWatch(w, "fed december", null)).toBe(true);
    expect(matchWatch(w, "economy cut", null)).toBe(true);
    expect(matchWatch(w, "fed bitcoin", null)).toBe(false);
    expect(matchWatch(w, "", "Politics")).toBe(false);
  });
  it("screener rows carry days left from the end date", () => {
    const now = Date.UTC(2026, 0, 1);
    const r = fromScreener({ conditionId: "0x2", question: "q", category: null, mid: 0.3, vol24h: 1200, endDate: "2026-01-11T00:00:00Z" } as ScreenerRow, now);
    expect(r.daysLeft).toBeCloseTo(10);
    expect(r.yes).toBe(0.3);
  });
  it("formats prices and days", () => {
    expect(pc(0.62)).toBe("62¢");
    expect(pc(0.625)).toBe("62.5¢");
    expect(pc(0.004)).toBe("<1¢");
    expect(pc(0.996)).toBe(">99¢");
    expect(pc(null)).toBe("—");
    expect(daysShort(0.5)).toBe("12h");
    expect(daysShort(12.4)).toBe("12d");
  });
});
