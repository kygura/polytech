// Narrow local input shapes for the paper book. Deliberately not imported from ../types.
export const MODES = ["L0", "L1", "L2", "L3", "L4"] as const;
export type Mode = (typeof MODES)[number];
export type Actor = "user" | "auto-downgrade" | "kill";
export type Outcome = 0 | 1;

export interface Forecast {
  p: number; // judge probability at the time
  pMarket: number; // market price at the time
  outcome: Outcome;
  category: string;
  model: string;
  roleMix: string;
}

export interface BookLevel {
  price: number;
  size: number; // shares
}

export interface Position {
  shares: number;
  avgCost: number; // per share, fees included
  realizedPnl: number;
}

export interface PaperFillResult {
  avgPrice: number; // VWAP
  shares: number;
  filled: number; // USD actually filled
  complete: boolean; // false when the book was too thin
  fee: number; // USD
}
