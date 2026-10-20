import { capacity, complementBook, slippageCurve, type Book, type SlippagePoint } from "@pm/core";

// Pure scale helpers for SlippagePane (DESIGN 12.6.3): log-x order size in USD, y = average fill price from best ask to best ask + 10c.
export const X_MIN = 10, X_MAX = 10_000;
export const X_TICKS = [10, 100, 1_000, 10_000];
export const Y_SPAN = 0.1; // prob units above the best ask
export const EPS_CENTS = [0.5, 1, 2] as const;
export const CURVE_N = 48;

const L0 = Math.log10(X_MIN), L1 = Math.log10(X_MAX);
/** Order size (USD) -> 0..1 along the log axis, clamped to the domain. */
export const xFrac = (usd: number) => Math.min(1, Math.max(0, (Math.log10(Math.max(usd, X_MIN)) - L0) / (L1 - L0)));
/** Inverse of `xFrac`. */
export const sizeAt = (f: number) => 10 ** (L0 + Math.min(1, Math.max(0, f)) * (L1 - L0));
/** Average fill price -> 0..1 (0 = best ask, 1 = best ask + 10c), clamped. */
export const yFrac = (p: number, ask: number) => Math.min(1, Math.max(0, (p - ask) / Y_SPAN));

/** `$10 $100 $1k $10k`; other values get thousands separators. */
export const usdLabel = (v: number) => (v >= 1000 && v % 1000 === 0 ? `$${v / 1000}k` : `$${Math.round(v).toLocaleString("en-US")}`);

/** CURVE_N log-spaced sizes over the axis domain. */
export const curveSizes = (n = CURVE_N) => Array.from({ length: n }, (_, i) => sizeAt(i / (n - 1)));

export type Side = "YES" | "NO";
/** The book for the chosen side: NO is the YES book's complement (NO asks = 1 - YES bids). */
export const sideBook = (yes: Book, side: Side): Book => (side === "YES" ? yes : complementBook(yes));

export type Curve = { ask: number; points: SlippagePoint[]; caps: { cents: number; usd: number }[] } | null;
/** Null under 2 ask levels (no curve to draw). */
export function curveOf(yes: Book, side: Side): Curve {
  const b = sideBook(yes, side);
  const asks = b.asks.filter((l) => l.price > 0 && l.price < 1 && l.size > 0);
  if (asks.length < 2) return null;
  const points = slippageCurve(b, curveSizes());
  if (!points.length) return null;
  return { ask: Math.min(...asks.map((l) => l.price)), points, caps: EPS_CENTS.map((c) => ({ cents: c, usd: capacity(b.asks, c / 100) })) };
}

/** Hover readout for a cursor size: `$1,200 → avg 0.431 · slip +1.1¢`; null when the book cannot fill it. */
export function readout(yes: Book, side: Side, usd: number): string | null {
  const p = slippageCurve(sideBook(yes, side), [usd])[0];
  return p ? `${usdLabel(usd)} → avg ${p.vwap.toFixed(3)} · slip +${(p.slippage * 100).toFixed(1)}¢` : null;
}

export const capLabel = (c: { cents: number; usd: number }) => `${c.cents}¢ ${usdLabel(c.usd)}`;
export const ariaLabel = (side: Side, c: Curve) => {
  const one = c?.caps.find((x) => x.cents === 1);
  return `Slippage curve, ${side}${one ? `, capacity at 1¢ ${usdLabel(one.usd)}` : ""}`;
};
