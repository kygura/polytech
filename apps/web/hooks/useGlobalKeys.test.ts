import { describe, expect, it } from "vitest";
import { chordTarget, GO, SHORTCUTS, shortcutsFor } from "./useGlobalKeys";

describe("g-chord map (DESIGN 12.1.3)", () => {
  it("routes", () => {
    const want: Record<string, string> = { m: "/markets", w: "/watchlist", t: "/trade", f: "/runs", r: "/research", j: "/journal", c: "/journal", p: "/paper", a: "/autonomy", s: "/settings" };
    for (const [k, path] of Object.entries(want)) expect(chordTarget(k, GO, true)).toEqual({ path });
  });
  it("g n is the alerts drawer, not a route, and only where the shell has one", () => {
    expect(chordTarget("n", GO, true)).toEqual({ alerts: true });
    expect(chordTarget("n", GO, false)).toBeNull();
  });
  it("a custom go map (the /trade shell) is respected; unknown keys do nothing", () => {
    expect(chordTarget("w", { w: "/trade" }, false)).toEqual({ path: "/trade" });
    expect(chordTarget("m", { w: "/trade" }, false)).toBeNull();
    expect(chordTarget("z", GO, true)).toBeNull();
  });
  it("g c is an unlisted alias: not in the sheet", () => {
    const rows = SHORTCUTS.flatMap((s) => s.keys.map(([k]) => k));
    expect(rows).toContain("g j");
    expect(rows).not.toContain("g c");
  });
  it("sheet: Global first, view scopes only on their view", () => {
    expect(shortcutsFor("/paper")[0]!.scope).toBe("Global");
    expect(shortcutsFor("/paper").map((s) => s.scope)).not.toContain("Market page");
    expect(shortcutsFor("/markets/0xabc").map((s) => s.scope)).toContain("Market page");
    expect(shortcutsFor("/markets").map((s) => s.scope)).not.toContain("Market page");
  });
});
