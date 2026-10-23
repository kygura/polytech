import { describe, expect, it } from "vitest";
import { checkQuote, urlKey } from "./quote";

const url = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm";
const pages = [{ url: "https://federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm/", text: "In support of its goals, the Committee decided to raise the target range for the federal funds rate to 3‑3/4 to 4 percent. Voting for the action were…" }];

describe("checkQuote", () => {
  it("found despite case, curly quotes, dashes and whitespace", () => {
    expect(checkQuote("the Committee decided to RAISE the target range  for the federal funds rate", url, pages)).toBe("found");
  });
  it("ellipsis fragments must each be found", () => {
    expect(checkQuote("the Committee decided … to 3-3/4 to 4 percent", url, pages)).toBe("found");
    expect(checkQuote("the Committee decided [...] to cut the rate", url, pages)).toBe("not_found");
  });
  it("a reworded or invented quote on a page that was read: not_found", () => {
    expect(checkQuote("the Committee voted to hike by 50 basis points", url, pages)).toBe("not_found");
  });
  it("no text for that url: unfetched", () => {
    expect(checkQuote("anything", "https://reuters.com/x", pages)).toBe("unfetched");
  });
  it("urlKey ignores www, case, fragment and trailing slash", () => {
    expect(urlKey("HTTPS://www.Example.com/a/#top")).toBe(urlKey("https://example.com/a"));
  });
});
