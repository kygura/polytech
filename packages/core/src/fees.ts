/** Taker fee per share: rate * (p(1-p))^exponent (Gamma feeSchedule {rate, exponent}; exponent 1 = the plain curve). Makers pay nothing. */
export function takerFeePerShare(feeRate: number, p: number, exponent = 1): number {
  if (!(feeRate >= 0) || !Number.isFinite(feeRate)) throw new RangeError(`bad feeRate ${feeRate}`);
  if (!(p >= 0 && p <= 1)) throw new RangeError(`bad price ${p}`);
  if (!(exponent >= 0) || !Number.isFinite(exponent)) throw new RangeError(`bad fee exponent ${exponent}`);
  return feeRate * Math.pow(p * (1 - p), exponent);
}

/** Fallback only: real rate comes from CLOB /fee-rate per market. */
export const FALLBACK_FEE_RATES: Record<string, number> = {
  politics: 0.04,
  finance: 0.04,
  tech: 0.04,
  crypto: 0.07,
  geopolitics: 0,
};
/** Conservative rate when neither the market nor its category says: assume fees apply. */
export const DEFAULT_FEE_RATE = 0.04;

export function feeRateFor(
  category: string,
  marketRate: number | null,
): { rate: number; fallback: boolean } {
  if (marketRate != null) return { rate: marketRate, fallback: false };
  return { rate: FALLBACK_FEE_RATES[category.toLowerCase()] ?? DEFAULT_FEE_RATE, fallback: true };
}

/** Stored fee exponent, null/undefined = 1 (the plain rate·p(1−p) curve). */
export const feeExponentOf = (exponent: number | null | undefined): number => (exponent != null && Number.isFinite(exponent) ? exponent : 1);
