// Plain-language names for the triage rules: shared by the triage job and the research desk (client-safe, no server imports).

export const TRIAGE_RULES = {
  CLOSED: "Market is closed or not taking orders",
  ENDS_TOO_SOON: "Resolves too soon to act on research",
  ENDS_TOO_LATE: "Resolves too far out: capital sits idle",
  EXCLUDED_CATEGORY: "Category excluded in Settings",
  NO_BOOK: "No order book to trade against",
  PRICE_EXTREME: "Priced under 3¢ or over 97¢: little left to win",
  WIDE_SPREAD: "Spread over 10¢: entry cost eats the edge",
  THIN_BOOK: "Too little money near the price to fill a trade",
} as const;
export type TriageRule = keyof typeof TRIAGE_RULES;

export const ruleText = (r: string) => TRIAGE_RULES[r as TriageRule] ?? r;
