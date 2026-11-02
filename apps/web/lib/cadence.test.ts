import { describe, expect, it } from "vitest";
import { STALE_MS as BANNER_STALE_MS } from "../components/StaleBanner";
import { SNAPSHOT_CADENCE_MS } from "../components/statusbar";
import { FULL_PASS_MS, SCOUT_KICK_MS, STALE_MS } from "./cadence";

describe("freshness cadence", () => {
  it("the stale banner fires one scout kick after a missed full pass, never inside one snapshot cadence", () => {
    expect(BANNER_STALE_MS).toBe(STALE_MS);
    expect(STALE_MS).toBe(FULL_PASS_MS + SCOUT_KICK_MS);
    expect(SNAPSHOT_CADENCE_MS).toBe(SCOUT_KICK_MS);
    expect(STALE_MS).toBeGreaterThan(SNAPSHOT_CADENCE_MS);
  });
});
