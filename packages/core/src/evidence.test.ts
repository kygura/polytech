import { describe, expect, it } from "vitest";
import { evidenceConfidence, hostOf, isPrimary, ruleHosts, UNVERIFIED_C } from "./evidence";

const RULES = "Resolves YES if the upper bound is 4.50% or higher per the FOMC statement. Source: https://www.federalreserve.gov/monetarypolicy.htm and https://www.cmegroup.com/fedwatch. Market page: https://polymarket.com/event/x";

describe("primary sources", () => {
  it("hostOf", () => {
    expect([hostOf("https://WWW.BLS.gov:443/cpi?x=1"), hostOf("http://user@ecb.europa.eu/p"), hostOf("ftp://x.gov"), hostOf("bls.gov")]).toEqual(["bls.gov", "ecb.europa.eu", null, null]);
  });
  it("ruleHosts: the resolution sources the rules name, venue dropped", () => {
    expect(ruleHosts(RULES)).toEqual(["federalreserve.gov", "cmegroup.com"]);
  });
  it("official domains and the named source (and its subdomains) count; press and the venue do not", () => {
    const src = ruleHosts(RULES);
    expect(isPrimary("https://www.bls.gov/cpi/", src)).toBe(true);
    expect(isPrimary("https://ec.europa.eu/eurostat", src)).toBe(true);
    expect(isPrimary("https://www.gov.uk/x", src)).toBe(true);
    expect(isPrimary("https://www.ons.gov.uk/x", src)).toBe(true);
    expect(isPrimary("https://data.cmegroup.com/fedwatch", src)).toBe(true);
    expect(isPrimary("https://www.reuters.com/markets/fed", src)).toBe(false);
    expect(isPrimary("https://polymarket.com/event/x", src)).toBe(false);
    expect(isPrimary("not a url", src)).toBe(false);
  });
});

describe("evidenceConfidence", () => {
  const fed = { url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm", direction: "-" as const };
  const press = { url: "https://www.reuters.com/x", direction: "-" as const };
  it("a primary fact on the thesis's side keeps the judge's confidence", () => {
    expect(evidenceConfidence(0.8, [press, fed], RULES, 0.02, 0.1)).toEqual({ c: 0.8, primary: 1 });
  });
  it("press only: capped", () => {
    expect(evidenceConfidence(0.8, [press], RULES, 0.02, 0.1)).toEqual({ c: UNVERIFIED_C, primary: 0 });
  });
  it("a primary fact from the other side does not back the thesis", () => {
    expect(evidenceConfidence(0.8, [fed], RULES, 0.3, 0.1)).toEqual({ c: UNVERIFIED_C, primary: 0 });
  });
  it("never raises a low judge confidence", () => {
    expect(evidenceConfidence(0.15, [], RULES, 0.02, 0.1).c).toBe(0.15);
  });
});
