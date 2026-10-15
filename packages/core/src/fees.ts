/** Taker fee per share. Makers pay nothing. */
export function takerFeePerShare(feeRate: number, p: number): number {
  if (!(feeRate >= 0) || !Number.isFinite(feeRate)) throw new RangeError(`bad feeRate ${feeRate}`);
  if (!(p >= 0 && p <= 1)) throw new RangeError(`bad price ${p}`);
  return feeRate * p * (1 - p);
}

/** Fallback only: real rate comes from CLOB /fee-rate per market. */
export const FALLBACK_FEE_RATES: Record<string, number> = {
  politics: 0.04,
  finance: 0.04,
  tech: 0.04,
  crypto: 0.07,
  geopolitics: 0,
};
const UNKNOWN_CATEGORY_RATE = 0.04; // conservative: assume fees apply

export function feeRateFor(
  category: string,
  marketRate: number | null,
): { rate: number; fallback: boolean } {
  if (marketRate != null) return { rate: marketRate, fallback: false };
  return { rate: FALLBACK_FEE_RATES[category.toLowerCase()] ?? UNKNOWN_CATEGORY_RATE, fallback: true };
}
