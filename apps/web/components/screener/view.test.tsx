import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, prefetch() {}, replace() {} }) }));
const { ScreenerView } = await import("./ScreenerView");
import type { ScreenerRow } from "./types";

const row = (i: number, o: Partial<ScreenerRow> = {}): ScreenerRow => ({
  conditionId: `0x${i}`, question: `Will thing ${i} happen?`, category: "politics", tags: ["a"], endDate: "2026-11-20T00:00:00Z", liquidity: 12000, vol24h: 3000, resolutionSource: "official_data", negRiskAugmented: false,
  ts: "2026-10-20T00:00:00Z", mid: 0.42, bestBid: 0.41, bestAsk: 0.43, spread: 0.02, depth1c: 100, depth2c: 400, depth5c: 900, exitDepth: 300, capacity: 150, holderCount: 40, holderHhi: 0.2, top1Share: 0.31, top5Share: 0.6,
  flow24h: -120, tradeMedian: 25, largeTrade24h: false, lastTradeTs: "2026-10-15T00:00:00Z", priority: 0.7, structural: ["overround"], opportunity: { side: "YES", edge: 0.034, stake: 50, o: 0.01234, contrarian: true }, pinned: true, muted: false,
  thesis: { id: "t", side: "YES", edgeC: 3.4, pPost: 0.45, expired: false }, ...o,
});
const props = (rows: ScreenerRow[], text = "days:2..120 sort:-prio") => ({ initial: { text, viewId: "default", rows, total: rows.length }, views: [], defaultText: text, now: Date.parse("2026-10-20T00:00:00Z"), lastSnapshotAt: Date.parse("2026-10-20T00:00:00Z") });

describe("ScreenerView SSR", () => {
  it("renders bar, count, default columns, badges and cells", () => {
    const h = renderToString(<ScreenerView {...props([row(1)])} />);
    for (const s of ["mkts</span>", "12.0k", "Will thing 1 happen?", "D±2¢", "Edge¢", "+3.4", "0.70", "0.0123", "5d", "off", 'aria-label="Query"', "[c] cols", "Default", 'title="no trade for 5d"']) expect(h).toContain(s);
    expect(h).toContain('aria-sort="descending"'); // sort:-prio
  });
  it("invalid query: error line, panel disabled, rows kept", () => {
    const h = renderToString(<ScreenerView {...props([row(1)], "liq:5k spred:<1")} />);
    expect(h).toContain('unknown key &quot;spred&quot;');
    expect(h).toContain("query has errors");
    expect(h).toContain("Will thing 1 happen?");
  });
  it("empty result shows the empty state", () => {
    expect(renderToString(<ScreenerView {...props([])} />)).toContain("No markets match. Loosen a range or drop a tag.");
  });
});
