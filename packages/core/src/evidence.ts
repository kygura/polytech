// Evidence gate on confidence: a thesis keeps the judge's confidence only when it rests on a primary source.

/** Confidence for a thesis that cites no primary source on its side: the market keeps most of the weight. */
export const UNVERIFIED_C = 0.4;

// public bodies and the international organisations that publish the data markets resolve on (.gov also covers federalreserve.gov, bls.gov, sec.gov...)
const OFFICIAL = [/\.gov$/, /(^|\.)gov\.[a-z]{2}$/, /(^|\.)gob\.[a-z]{2}$/, /(^|\.)gouv\.[a-z]{2}$/, /(^|\.)go\.[a-z]{2}$/, /\.mil$/, /\.int$/, /(^|\.)europa\.eu$/, /(^|\.)un\.org$/,
  /(^|\.)bankofengland\.co\.uk$/, /(^|\.)bankofcanada\.ca$/, /(^|\.)boj\.or\.jp$/, /(^|\.)bis\.org$/, /(^|\.)imf\.org$/, /(^|\.)worldbank\.org$/];
// where the market itself lives: every analyst already has the rules text in the brief, so quoting it proves no extra diligence
const VENUE = /(^|\.)polymarket\.com$/;

/** Lower-case host of an http(s) url, `www.` dropped; null when it is not one. (core has no URL global: no DOM or node types.) */
export function hostOf(url: string): string | null {
  const m = /^https?:\/\/(?:[^@/?#\s]*@)?([^/:?#\s]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase().replace(/^www\./, "") : null;
}

/** Hosts the rules name (the resolution source), venue excluded. */
export function ruleHosts(rules: string): string[] {
  const hs = (rules.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? []).map(hostOf).filter((h): h is string => !!h && !VENUE.test(h));
  return [...new Set(hs)];
}

/** Official domain, or the resolution source the rules name (same host or a subdomain of it). */
export function isPrimary(url: string, sources: readonly string[]): boolean {
  const h = hostOf(url);
  if (!h || VENUE.test(h)) return false;
  return OFFICIAL.some((r) => r.test(h)) || sources.some((s) => h === s || h.endsWith(`.${s}`));
}

export type Fact = { url: string; direction: "+" | "-" };

/**
 * The judge's confidence stands when at least one fact from an analyst on the thesis's side of the book (direction "+" when
 * p_hat is above the mid, "-" below) cites a primary source; otherwise it is capped at UNVERIFIED_C.
 */
export function evidenceConfidence(c: number, facts: readonly Fact[], rules: string, pHat: number, pMid: number): { c: number; primary: number } {
  const side = pHat >= pMid ? "+" : "-", src = ruleHosts(rules);
  const primary = facts.filter((f) => f.direction === side && isPrimary(f.url, src)).length;
  return { c: primary > 0 ? c : Math.min(c, UNVERIFIED_C), primary };
}
