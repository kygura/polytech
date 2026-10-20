import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { backTarget, listOf } from "./BackLink";
import { HeaderBadges, structuralReason } from "./terminal/MarketHeader";
import { MetricsGrid } from "./MetricsGrid";
import { Segmented } from "./ui";

const NOW = 1_800_000_000_000, H = 3_600_000;
const attr = (html: string, k: string) => [...html.matchAll(new RegExp(`${k}="([^"]*)"`, "g"))].map((m) => m[1]);

describe("Segmented", () => {
  it("is a radiogroup with one tab stop on the selected option", () => {
    const h = renderToStaticMarkup(<Segmented label="Range" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} value="b" onChange={() => {}} />);
    expect(h).toContain('role="radiogroup"');
    expect(attr(h, "aria-checked")).toEqual(["false", "true"]);
    expect(attr(h, "tabindex")).toEqual(["-1", "0"]);
  });
});

describe("header badges", () => {
  it("S per kind (reason in title), then C, then Z only past 48 h", () => {
    const h = renderToStaticMarkup(<HeaderBadges now={NOW} flags={{ structural: ["overround", "sibling_inconsistency"], contrarian: true, lastTradeTs: NOW - 72 * H, detail: { type: "neg-risk-sum", lockedC: 4.1, sum: 1.06 } }} />);
    expect(h.match(/>[SCZ]</g)).toEqual([">S<", ">S<", ">C<", ">Z<"]);
    expect(attr(h, "title")).toEqual(["overround +4.1¢ net of fees", "sibling sum 1.06", "contrarian", "no trade for 3d"]);
  });
  it("nothing flagged renders nothing; a 47 h old trade is not stale", () => {
    expect(renderToStaticMarkup(<HeaderBadges now={NOW} flags={{ structural: null, contrarian: false, lastTradeTs: NOW - 47 * H }} />)).toBe("");
    expect(renderToStaticMarkup(<HeaderBadges now={NOW} flags={{ structural: [], contrarian: false, lastTradeTs: null }} />)).toBe("");
  });
  it("reasons fall back to the kind", () => {
    expect(structuralReason("monotonicity_violation", { type: "ladder", lockedC: 1.5, sum: null })).toBe("ladder: monotonicity violated, +1.5¢ net");
    expect(structuralReason("monotonicity_violation")).toBe("ladder: monotonicity violated");
    expect(structuralReason("whatever")).toBe("whatever");
  });
});

describe("MetricsGrid", () => {
  const latest = {
    conditionId: "c", ts: NOW, mid: 0.42, bestBid: 0.41, bestAsk: 0.43, spread: 0.02, depth1c: 1200, depth2c: 3400, depth5c: 9000, exitDepth: 800, capacity: 1840,
    bookHash: null, midChangedAt: null, holderCount: 120, holderHhi: 0.0512, top1Share: 0.12, top5Share: 0.4, flow24h: -350, tradeMedian: 25, largeTrade24h: true,
    lastTradeTs: NOW - 5 * H, priority: 0.8, structural: null, opportunity: null,
  };
  const m = { feeRate: 0.02, liquidity: 25_000, vol24h: 4_000, resolutionSource: "official_data" };
  it("24 labelled cells in a dl; nulls are dashes; flow is signed", () => {
    const h = renderToStaticMarkup(<MetricsGrid latest={latest} market={m} oi={50_000} now={NOW} />);
    expect(h).toContain("<dl");
    expect(h.match(/<dt>/g)).toHaveLength(24);
    expect(h).toContain("<dt>spread (¢)</dt><dd>2.0</dd>");
    expect(h).toContain("<dt>HHI</dt><dd>0.05</dd>");
    expect(h).toContain("<dt>fee</dt><dd>2.0%</dd>");
    expect(h).toContain('class="neg"');
    expect(h).toContain("<dt>stale (h)</dt><dd>5</dd>");
    expect(h).toContain("<dt>src</dt><dd><span title=\"official_data\">off</span></dd>");
  });
  it("no market_latest row: every latest cell is a dash, nothing throws", () => {
    const h = renderToStaticMarkup(<MetricsGrid latest={null} market={{ feeRate: null, liquidity: null, vol24h: null, resolutionSource: null }} oi={null} now={NOW} />);
    expect(h.match(/<dd><span class="muted">—<\/span><\/dd>/g)).toHaveLength(24);
  });
});

describe("BackLink helpers", () => {
  it("only an exact list route is remembered; unknown stored values fall back to the screener", () => {
    expect(["/markets", "/watchlist", "/runs", "/journal", "/runs/abc", "/markets/0x1", "/settings"].map(listOf)).toEqual(["/markets", "/watchlist", "/runs", "/journal", null, null, null]);
    expect(backTarget("/watchlist")).toBe("/watchlist");
    expect(backTarget("/runs")).toBe("/runs");
    expect(backTarget("https://evil.test/watchlist")).toBe("/markets");
    expect(backTarget(null)).toBe("/markets");
  });
});
