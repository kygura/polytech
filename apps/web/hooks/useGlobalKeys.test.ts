import { describe, expect, it } from "vitest";
import { chordTarget, GO, SHORTCUTS, shortcutsFor } from "./useGlobalKeys";

describe("g-chord map (DESIGN 13.7)", () => {
  it("routes", () => {
    const want: Record<string, string> = { m: "/markets", t: "/trade", w: "/watchlist", r: "/research", f: "/runs", u: "/runs", j: "/journal", p: "/paper", a: "/autonomy", s: "/settings" };
    expect(Object.keys(GO).sort()).toEqual(Object.keys(want).sort());
    for (const [k, path] of Object.entries(want)) expect(chordTarget(k, true)).toEqual({ path });
  });
  it("g n is the alerts drawer, not a route, and only where the shell has one", () => {
    expect(chordTarget("n", true)).toEqual({ alerts: true });
    expect(chordTarget("n", false)).toBeNull();
    expect(chordTarget("z", true)).toBeNull();
  });
  it("g u is an unlisted alias of g f: not in the sheet; the visitor g o chord is gone", () => {
    const rows = SHORTCUTS.flatMap((s) => s.keys.map(([k]) => k));
    expect(rows).toContain("g f");
    expect(rows).not.toContain("g u");
    expect(chordTarget("o", true)).toBeNull();
  });
  it("sheet: Global first, view scopes only on their view", () => {
    expect(shortcutsFor("/paper")[0]!.scope).toBe("Global");
    expect(shortcutsFor("/paper").map((s) => s.scope)).not.toContain("Market page");
    expect(shortcutsFor("/paper").map((s) => s.scope)).not.toContain("Trade");
    expect(shortcutsFor("/trade").map((s) => s.scope)).toEqual(["Global", "Lists", "Alerts drawer", "Trade"]);
    expect(shortcutsFor("/trade/0xabc").map((s) => s.scope)).toContain("Trade");
    expect(shortcutsFor("/markets/0xabc").map((s) => s.scope)).toContain("Market page");
    expect(shortcutsFor("/markets").map((s) => s.scope)).not.toContain("Market page");
  });
});
