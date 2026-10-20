import { describe, expect, test } from "vitest";
import { classifyResolutionSource } from "./classify";

const c = (question: string, description = "", resolutionSource: string | null = null) =>
  classifyResolutionSource(question, description, resolutionSource);

describe("classifyResolutionSource", () => {
  test("official data", () => {
    expect(c("Will CPI YoY for September be ≥ 3.1%?", "This market resolves according to the Bureau of Labor Statistics CPI release.", "https://www.bls.gov/cpi/")).toBe("official_data");
    expect(c("Fed decision in December?", "Resolves to the FOMC target range published by the Federal Reserve.")).toBe("official_data");
    expect(c("US unemployment rate above 4.5% in October?", "Based on the jobs report.")).toBe("official_data");
    expect(c("Will the US Census report population over 340M?", "")).toBe("official_data");
    expect(c("Who wins the Georgia Senate race?", "Resolves per the official results certified by the Secretary of State.")).toBe("official_data");
    expect(c("Highest temperature in NYC on Aug 3 above 90F?", "According to NOAA data for Central Park.")).toBe("official_data");
    expect(c("Will the FDA approve drug X by June 30?", "According to the FDA website.", "https://www.fda.gov")).toBe("official_data");
    expect(c("Q3 GDP growth above 2%?", "Per BEA advance estimate.", "https://www.bea.gov/")).toBe("official_data");
  });
  test("scheduled events", () => {
    expect(c("Lakers vs. Celtics: who wins on Dec 25?", "Resolves to the winner of the scheduled NBA game.")).toBe("scheduled_event");
    expect(c("Will Arsenal win the Premier League match on Saturday?", "Based on the final score after 90 minutes.")).toBe("scheduled_event");
    expect(c("Will Tesla beat Q3 earnings EPS estimates?", "Resolves per the earnings report.")).toBe("scheduled_event");
    expect(c("Who will win the Super Bowl?", "")).toBe("scheduled_event");
    expect(c("UFC 310: Will fighter A win?", "")).toBe("scheduled_event");
    expect(c("Will the event take place as scheduled on March 3?", "")).toBe("scheduled_event");
    expect(c("Oscars 2027: Best Picture winner?", "")).toBe("scheduled_event");
  });
  test("media reports", () => {
    expect(c("Will Company X announce layoffs by June?", "Resolves YES if layoffs are reported by Reuters, Bloomberg, or another major news outlet.")).toBe("media_report");
    expect(c("Will Y resign by year end?", "This market will resolve based on a consensus of credible reporting.")).toBe("media_report");
    expect(c("Will the merger close?", "", "https://www.nytimes.com/")).toBe("media_report");
    expect(c("Will Z be indicted?", "According to reports by the Associated Press.")).toBe("media_report");
  });
  test("subjective", () => {
    expect(c("Is Taylor Swift the greatest artist of all time?", "Resolves YES if she is widely considered the greatest.")).toBe("subjective");
    expect(c("Will AI be conscious by 2030?", "In the opinion of a majority of experts.")).toBe("subjective");
    expect(c("Will the expert consensus be that X?", "")).toBe("subjective");
    expect(c("Will the bill be a success?", "At the sole discretion of the market creator.")).toBe("subjective");
  });
  test("Polymarket 'consensus of ...' boilerplate is not subjective", () => {
    expect(c("Will X happen?", "This market will resolve according to a consensus of credible reporting.")).toBe("media_report");
    expect(c("Will X happen?", "Resolves based on a consensus of information from multiple sources.")).toBe("media_report");
    expect(c("Will X happen?", "Resolution is by consensus of reporting.")).toBe("media_report");
    expect(c("Will X happen?", "According to a consensus of official sources, including government websites.")).toBe("official_data");
    expect(c("Will X happen?", "Resolves per a consensus of official information.")).toBe("official_data");
    expect(c("Will it be the best film?", "Based on critical consensus.")).toBe("subjective");
    expect(c("Is X good?", "Per popular opinion polls of fans.")).toBe("subjective");
    expect(c("Will X happen?", "Analyst consensus estimate.")).toBe("unknown");
  });
  test("subjective phrasing overrides objective cues", () => {
    expect(c("Will inflation be a problem?", "In the opinion of the Bureau of Labor Statistics commissioner.")).toBe("subjective");
  });
  test("unknown", () => {
    expect(c("Will Elon Musk tweet about Dogecoin this week?", "")).toBe("unknown");
    expect(c("", "")).toBe("unknown");
    expect(c("Something vague", "No details", null)).toBe("unknown");
  });
  test("resolutionSource alone, case-insensitive, tolerant of missing fields", () => {
    expect(c("Will it happen?", "", "https://www.federalreserve.gov/")).toBe("official_data");
    expect(c("Will it happen?", "", "ESPN")).toBe("scheduled_event");
    expect(c("WILL THE FOMC CUT RATES?", "")).toBe("official_data");
    expect(classifyResolutionSource("x", undefined, undefined)).toBe("unknown");
  });
  test("no false positive on substrings", () => {
    expect(c("Will the Federation of X announce a deal?", "")).not.toBe("official_data");
    expect(c("Will a gamer win the lottery?", "")).toBe("unknown");
  });
});
