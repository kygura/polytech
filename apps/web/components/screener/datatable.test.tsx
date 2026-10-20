import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable, type Column } from "../DataTable";

type R = { id: string };
const rows: R[] = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}` }));
const cols: Column<R>[] = [{ id: "id", header: "Id", align: "l", width: "80px", cell: (r) => r.id }, { id: "x", header: "X", align: "r", minWidth: "200px", cell: () => "x" }];
const html = (virtual?: Parameters<typeof DataTable<R>>[0]["virtual"]) => renderToStaticMarkup(<DataTable columns={cols} rows={rows} rowKey={(r) => r.id} virtual={virtual} />);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("DataTable virtual", () => {
  it("renders a window between two spacers whose heights are the hidden rows x 26", () => {
    const h = html({ rowHeight: 26, overscan: 20, height: "400px" });
    const rendered = count(h, /<tr[^>]*aria-rowindex/g);
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(80);
    expect(h).toContain("m0<");
    expect(h).not.toContain("m999<");
    expect(h).toContain(`height:${(1000 - rendered) * 26}px`); // bottom spacer (no top spacer at scrollTop 0)
    expect(count(h, /aria-hidden="true"><td/g)).toBe(1);
    expect(h).toContain('aria-rowcount="1001"');
    expect(h).toContain("min-width:280px"); // 80 + flex floor 200
    expect(h).toContain("height:400px");
  });
  it("without `virtual` every row renders and nothing else changes", () => {
    const h = html();
    expect(count(h, /<tr/g)).toBe(1001);
    expect(h).not.toContain("aria-rowcount");
    expect(h).not.toContain("aria-hidden");
    expect(h).toContain("m999<");
  });
});
