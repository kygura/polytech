import { summarize } from "@pm/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
const { JournalView } = await import("../../app/(app)/journal/JournalView");

describe("JournalView with 0 resolved", () => {
  it("keeps the KPI strip and charts, watermarked n=0 · low confidence", () => {
    const data = { summary: summarize([]), rows: [], bins: [], suggested: null };
    const h = renderToString(<JournalView data={data as never} filters={{ category: "", model: "", sinceDays: "", groupBy: "category", minN: 5 }} categories={[]} models={[]} extremize={1} />).replace(/<!-- -->/g, "");
    expect(h).toContain("No resolved theses yet.");
    expect(h).toContain('aria-label="journal KPIs"');
    expect(h).toContain("Reliability");
    expect(h).toContain("Paper P&amp;L");
    expect(h.match(/n=0 · low confidence/g)?.length ?? 0).toBe(4);
  });
});
