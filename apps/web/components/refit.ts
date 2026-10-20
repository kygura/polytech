// DESIGN 12.4 refit card: PUT /api/settings bodies. Apply writes extremize and clears the suggestion in one request; Dismiss only clears it.
export type Suggested = { extremize: number; n: number; at: string };

export const refitPayload = (mode: "apply" | "dismiss", s: Suggested): { extremize?: number; suggested: null } =>
  mode === "apply" ? { extremize: s.extremize, suggested: null } : { suggested: null };

export const refitDelta = (current: number, s: Suggested) => `${s.extremize - current < 0 ? "−" : "+"}${Math.abs(s.extremize - current).toFixed(2)}`;

export const refitConfirm = (s: Suggested) => `Apply extremize ${s.extremize.toFixed(2)}? Future p̂ blends use it; past journal rows are not rewritten.`;
