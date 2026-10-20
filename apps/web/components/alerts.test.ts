import { describe, expect, it } from "vitest";
import { alertHref, applyAck, kindOf, listKey, parseAlerts } from "./alerts";

const row = (o: Record<string, unknown>) => ({ id: 1, conditionId: "0xabc", kind: "mid_move", message: "m", data: null, createdAt: "1970-01-01T00:00:01.000Z", ackedAt: null, question: "Will X?", ...o });

describe("alerts model", () => {
  it("parseAlerts normalises times and counts, and rejects junk", () => {
    const p = parseAlerts({ rows: [row({}), row({ id: 2, ackedAt: 5000 }), { nope: 1 }], unacked: 7 })!;
    expect(p.rows.map((a) => [a.id, a.createdAt, a.ackedAt])).toEqual([[1, 1000, null], [2, 1000, 5000]]);
    expect(p.unacked).toBe(7);
    expect(parseAlerts({ rows: [row({}), row({ id: 2, ackedAt: 1 })] })!.unacked).toBe(1);
    expect(parseAlerts(null)).toBeNull();
    expect(parseAlerts({ error: "x" })).toBeNull();
  });
  it("kind glyphs; unknown kinds degrade", () => {
    expect(kindOf("run_failed").glyph).toBe("✕");
    expect(kindOf("structural").tone).toBe("var(--badge-s)");
    expect(kindOf("odd_kind").label).toBe("odd kind");
  });
  it("alertHref: run_failed -> pod, others -> market", () => {
    expect(alertHref({ kind: "run_failed", conditionId: "0xabc", data: { podId: "p1" } })).toBe("/runs/p1");
    expect(alertHref({ kind: "run_failed", conditionId: "0xabc", data: null })).toBeNull();
    expect(alertHref({ kind: "structural", conditionId: "0xabc", data: null })).toBe("/markets/0xabc");
    expect(alertHref({ kind: "structural", conditionId: null, data: null })).toBeNull();
  });
  it("listKey clamps and maps j/k/Enter/a/A", () => {
    expect(listKey("j", 2, 3)).toEqual({ sel: 2, act: null });
    expect(listKey("k", 0, 3)).toEqual({ sel: 0, act: null });
    expect(listKey("j", 0, 3)).toEqual({ sel: 1, act: null });
    expect(listKey("Enter", 1, 3)).toEqual({ sel: 1, act: "open" });
    expect(listKey("a", 1, 3)!.act).toBe("ack");
    expect(listKey("A", 0, 0)!.act).toBe("ackAll");
    expect(listKey("a", 0, 0)!.act).toBeNull();
    expect(listKey("x", 0, 3)).toBeNull();
  });
  it("applyAck flips one or all open rows and recounts", () => {
    const rows = parseAlerts({ rows: [row({ id: 1 }), row({ id: 2 }), row({ id: 3, ackedAt: 1 })] })!.rows;
    expect(applyAck(rows, 2, 9).unacked).toBe(1);
    expect(applyAck(rows, undefined, 9)).toMatchObject({ unacked: 0 });
    expect(applyAck(rows, undefined, 9).rows[2]!.ackedAt).toBe(1); // already acked keeps its time
    expect(applyAck(rows, 99, 9).unacked).toBe(2);
  });
});
