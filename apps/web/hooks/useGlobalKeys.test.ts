import { afterEach, describe, expect, it, vi } from "vitest";
import { chordKey, chordTarget, GO, SHORTCUTS, shortcutsFor, useGlobalKeys } from "./useGlobalKeys";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("react", () => ({ useEffect: (f: () => void) => { f(); } })); // run the effect inline: no renderer needed

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
    expect(shortcutsFor("/paper").map((s) => s.scope)).not.toContain("Trade");
    expect(shortcutsFor("/trade").map((s) => s.scope)).toEqual(["Global", "Lists", "Alerts drawer", "Trade"]);
    expect(shortcutsFor("/trade/0xabc").map((s) => s.scope)).toContain("Trade");
    expect(shortcutsFor("/markets/0xabc").map((s) => s.scope)).not.toContain("Market page"); // that route redirects to /trade/[id]
    const trade = SHORTCUTS.find((s) => s.scope === "Trade")!.keys.map(([k]) => k);
    expect(trade).toEqual(expect.arrayContaining(["1 2 3 4", "e", "[ / ]", "f", "p / m / r", "Shift S"]));
    expect(trade).not.toContain("p / o");
  });
});

describe("the key that completes a g chord is not a page key", () => {
  const key = (k: string) => ({ key: k, defaultPrevented: false, target: null, metaKey: false, ctrlKey: false, altKey: false, preventDefault() { this.defaultPrevented = true; } });
  let fire: (e: ReturnType<typeof key>) => void;
  const mount = () => {
    vi.stubGlobal("window", { addEventListener: (_: string, f: typeof fire) => { fire = f; }, removeEventListener: () => {} });
    vi.stubGlobal("document", { querySelector: () => null, activeElement: null });
    useGlobalKeys({ onHelp: () => {}, onTheme: () => {} });
  };
  afterEach(() => { vi.unstubAllGlobals(); push.mockClear(); vi.useRealTimers(); });

  it("route chords navigate and are consumed", () => {
    vi.useFakeTimers(); mount();
    fire(key("g"));
    const r = key("r");
    fire(r);
    expect(push).toHaveBeenCalledWith("/research");
    expect(r.defaultPrevented).toBe(true);
    expect(chordKey(r)).toBe(true);
  });
  it("non-route second keys (g b, g 1) are consumed too, so page keys bail", () => {
    vi.useFakeTimers(); mount();
    for (const k of ["b", "1", "y", "e"]) {
      fire(key("g"));
      const e = key(k);
      fire(e);
      expect(e.defaultPrevented).toBe(true);
    }
    expect(push).not.toHaveBeenCalled();
  });
  it("a plain key with no g before it stays free; so does one after the chord window", () => {
    vi.useFakeTimers(); mount();
    const a = key("b");
    fire(a);
    expect(a.defaultPrevented).toBe(false);
    expect(chordKey(a)).toBe(false);
    fire(key("g"));
    vi.advanceTimersByTime(900);
    const b = key("b");
    fire(b);
    expect(b.defaultPrevented).toBe(false);
  });
});
