import { describe, expect, it } from "vitest";
import { feedAge, feedStatus, FEED_STALE_MS } from "./useMarketFeed";

describe("feedStatus", () => {
  it("loading / error without data; live / stale with data", () => {
    expect(feedStatus(false, false, 0)).toBe("loading");
    expect(feedStatus(false, true, 0)).toBe("error");
    expect(feedStatus(true, false, 0)).toBe("live");
    expect(feedStatus(true, true, 0)).toBe("stale");
    expect(feedStatus(true, false, FEED_STALE_MS + 1)).toBe("stale");
  });
  it("age comes from the server stamp: a response cached 10 s upstream is stale on arrival", () => {
    const now = 1_000_000, f = { at: now - 10_000 };
    expect(feedStatus(true, false, feedAge(f, now))).toBe("stale");
    expect(feedStatus(true, false, feedAge({ at: now - 1_000 }, now))).toBe("live");
  });
});
