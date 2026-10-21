import { describe, expect, it } from "vitest";
import { ageTone, fmtAge, nextRetry, parseStatus, runsLabel, spendLabel, sseDetail, tradingLabel, utcClock } from "./statusbar";

describe("status bar helpers", () => {
  it("parseStatus accepts a run count or a list, epoch or ISO times, and rejects junk", () => {
    const a = parseStatus({ activeRuns: 2, spendToday: { usd: 4.12, capUsd: 25 }, lastSnapshotAt: 1000, lastSweepAt: null, unackedAlerts: 3 });
    expect(a).toMatchObject({ runs: 2, spendUsd: 4.12, capUsd: 25, snapshotAt: 1000, sweepAt: null, unacked: 3 });
    const b = parseStatus({ activeRuns: [{ id: "abcdef0123456789", stage: "debate", question: "Will X?" }], spendTodayUsd: 1, dailyCapUsd: 2, lastSnapshotAt: "1970-01-01T00:00:01.000Z" });
    expect(b).toMatchObject({ runs: 1, pods: ["abcdef01 · debate · Will X?"], spendUsd: 1, capUsd: 2, snapshotAt: 1000, unacked: 0 });
    // server shape: capped list + true count; tooltip lines come from the list
    const c = parseStatus({ activeRuns: [{ id: "abcdef0123456789", stage: "agents", question: "Will X?" }, { id: "99", stage: null, question: null }], activeRunCount: 12 });
    expect(c).toMatchObject({ runs: 12, pods: ["abcdef01 · agents · Will X?", "99 · ? · "] });
    expect(parseStatus(null)).toBeNull();
    expect(parseStatus({ error: "x" })).toMatchObject({ runs: 0, spendUsd: null });
  });
  it("fmtAge", () => {
    expect([null, 5_000, 7 * 60_000, 2 * 3_600_000, 47 * 3_600_000, 72 * 3_600_000].map(fmtAge)).toEqual(["—", "5s", "7m", "2h", "47h", "3d"]);
  });
  it("ageTone: <2x text, up to 6x warn, beyond neg (snapshot 15 min)", () => {
    const c = 15 * 60_000;
    expect([null, 0, 29 * 60_000, 30 * 60_000, 90 * 60_000, 91 * 60_000].map((a) => ageTone(a, c))).toEqual(["muted", "text", "text", "warn", "warn", "neg"]);
  });
  it("spendLabel", () => {
    expect(spendLabel(4.12, 25)).toEqual({ text: "spend $4.12 / $25.00", capped: false });
    expect(spendLabel(25.4, 25)).toEqual({ text: "cap reached $25.40 / $25.00", capped: true });
    expect(spendLabel(25, 25).capped).toBe(true);
    expect(spendLabel(null, 25).text).toBe("spend —");
    expect(spendLabel(3, 0)).toEqual({ text: "spend $3.00", capped: false });
  });
  it("tradingLabel: paper is quiet, LIVE warns in words", () => {
    expect(tradingLabel("paper")).toEqual({ text: "paper", warn: false });
    expect(tradingLabel("live")).toEqual({ text: "LIVE", warn: true });
  });
  it("runsLabel / sseDetail / retry countdown / clock", () => {
    expect([runsLabel(0), runsLabel(2)]).toEqual(["runs idle", "runs 2 active"]);
    expect(sseDetail("offline", null, 3)).toBe(" · retrying");
    expect(sseDetail("reconnecting", null, 2)).toBe(" · 2s");
    expect(sseDetail("live", null, 3)).toBe("");
    expect([3, 2, 1].map(nextRetry)).toEqual([2, 1, 3]);
    expect(utcClock(Date.UTC(2026, 9, 20, 14, 2, 11))).toBe("14:02:11 UTC");
  });
});
