import { describe, expect, it } from "vitest";
import { probeUrl } from "./probe";

describe("probeUrl", () => {
  it("maps views to the endpoint that really exists, by first segment", () => {
    expect(probeUrl("/runs")).toBe("/api/fleet");
    expect(probeUrl("/runs/abc123")).toBe("/api/pods/abc123");
    expect(probeUrl("/journal", "?groupBy=model")).toBe("/api/calibration");
    expect(probeUrl("/research")).toBe("/api/research/profiles");
    expect(probeUrl("/research/x")).toBe("/api/research/profiles");
    expect(probeUrl("/markets", "?q=liq:5k")).toBe("/api/markets?q=liq:5k");
    expect(probeUrl("/markets/0xabc")).toBe("/api/markets/0xabc");
    expect(probeUrl("/watchlist", "?tab=size")).toBe("/api/watchlist?tab=size");
  });
  it("unknown or nested-unknown routes skip the probe", () => {
    expect(probeUrl("/runs/abc/extra")).toBeNull();
    expect(probeUrl("/nope")).toBeNull();
    expect(probeUrl("/")).toBeNull();
  });
});
