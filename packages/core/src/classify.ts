// Heuristic rule classifier (SPEC.md Stage-1): keyword/regex over question + description + resolutionSource.
export type ResolutionSourceType = "official_data" | "scheduled_event" | "media_report" | "subjective" | "unknown";

const re = (...parts: string[]) => new RegExp(parts.join("|"), "i");

/**
 * Subjective only with an explicit opinion qualifier. Polymarket boilerplate ("consensus of credible reporting / of information /
 * of official sources") is NOT subjective: it is media_report (or official_data when it names official sources).
 */
const SUBJECTIVE = re(
  "in the opinion of", "widely (?:considered|regarded|seen|viewed)", "generally (?:considered|regarded)", "sole discretion",
  "at the discretion of", "(?:expert|critical|popular|general|scientific|public|majority) (?:opinion|consensus)",
  "consensus (?:of|among) (?:the )?(?:experts?|critics?|scholars?|historians?|opinion)", "subjective",
  "as determined by the market creator", "in my (?:judgment|opinion)",
);
const OFFICIAL = re(
  "consensus of (?:\\w+\\s+){0,2}official(?:\\s+\\w+){0,2}\\s+(?:sources?|information|reporting)",
  "\\bbls\\b", "bureau of labor statistics", "\\bcpi\\b", "consumer price index", "\\bpce\\b", "\\bfomc\\b", "federal reserve", "\\bthe fed\\b",
  "federal funds", "fed funds", "census", "\\bgdp\\b", "unemployment rate", "jobs report", "nonfarm", "non-farm", "initial claims",
  "official (?:results?|data|statistics|figures|website|tally)", "certified (?:results?|vote)", "\\bnoaa\\b", "national weather service",
  "\\bbea\\b", "\\bbureau of economic analysis\\b", "\\bsec\\.gov\\b", "\\bfda\\b", "\\bcdc\\b", "\\beia\\b", "treasury (?:yield|department)",
  "\\.gov\\b", "according to (?:the )?(?:u\\.?s\\.? |us |federal |national |european |uk )?(?:bureau|department|agency|office|commission|administration|ministry|central bank|statistics)",
  "\\becb\\b", "bank of england", "\\bimf\\b", "world bank", "\\bbls\\.gov\\b",
);
const SCHEDULED = re(
  "\\bnba\\b", "\\bnfl\\b", "\\bmlb\\b", "\\bnhl\\b", "\\bmls\\b", "\\bufc\\b", "\\bwnba\\b", "\\batp\\b", "\\bwta\\b", "\\bfifa\\b", "\\buefa\\b",
  "premier league", "la liga", "serie a", "bundesliga", "champions league", "europa league", "world cup", "super bowl", "world series",
  "stanley cup", "nba finals", "grand prix", "\\bformula (?:1|one)\\b", "\\bf1\\b", "olympic", "wimbledon", "us open", "french open", "masters tournament",
  "\\bvs\\.?\\s", "\\bfinal score\\b", "\\bkick-?off\\b", "tip-?off", "first pitch", "\\bmatch\\b", "\\bfixture\\b",
  "\\bearnings\\b", "\\beps\\b", "quarterly results", "\\bscheduled\\b", "\\boscars?\\b", "academy awards?", "\\bgrammys?\\b", "\\bemmys?\\b",
  "\\bespn\\b", "\\bnba\\.com\\b", "\\bnfl\\.com\\b", "\\buefa\\.com\\b",
);
const MEDIA = re(
  "reported by", "consensus of (?:\\w+\\s+){0,2}(?:information|reporting|sources?)", "according to (?:media )?reports?", "credible (?:media |news )?(?:reporting|reports?|sources?)", "consensus of credible",
  "major (?:news|media)", "news outlets?", "media (?:reports?|outlets?)", "\\breuters\\b", "associated press", "\\bap news\\b", "bloomberg",
  "\\bcnn\\b", "\\bbbc\\b", "new york times", "nytimes", "wall street journal", "\\bwsj\\b", "washington post", "financial times",
  "\\bthe guardian\\b", "\\bcnbc\\b", "fox news", "politico", "axios", "announce(?:s|d)? (?:publicly|officially)",
);

export function classifyResolutionSource(
  question: string | null | undefined,
  description: string | null | undefined,
  resolutionSource: string | null | undefined,
): ResolutionSourceType {
  const text = [question, description, resolutionSource].filter((s): s is string => typeof s === "string").join("\n");
  if (!text.trim()) return "unknown";
  if (SUBJECTIVE.test(text)) return "subjective";
  if (OFFICIAL.test(text)) return "official_data";
  if (SCHEDULED.test(text)) return "scheduled_event";
  if (MEDIA.test(text)) return "media_report";
  return "unknown";
}
