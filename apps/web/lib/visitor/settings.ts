// Visitor autonomy settings: one localStorage key, validated with the core AppSettings field schemas (same bounds as the operator's).
// A corrupt or missing value falls back to the defaults (mode manual): a bad blob can never switch the loop on.
import { AppSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from "@pm/core";
import { z } from "zod";

export const SETTINGS_KEY = "polytech.visitor.settings";
export const VISITOR_MODES = ["manual", "L2", "L3", "L4"] as const;
export type VisitorMode = (typeof VISITOR_MODES)[number];
export type SettingsStore = Pick<Storage, "getItem" | "setItem">;

const F = AppSettingsSchema.shape;
/** bankroll, Kelly fraction, risk limits (incl. l3 caps + category allowlist) + loop mode. Everything else (filters, fees...) is the core default. */
export const VisitorSettingsSchema = z.strictObject({ mode: z.enum(VISITOR_MODES), bankroll: F.bankroll, kelly: F.kelly, limits: F.limits });
export type VisitorSettings = z.infer<typeof VisitorSettingsSchema>;

export const DEFAULT_VISITOR_SETTINGS: VisitorSettings = {
  mode: "manual", bankroll: DEFAULT_APP_SETTINGS.bankroll, kelly: DEFAULT_APP_SETTINGS.kelly, limits: DEFAULT_APP_SETTINGS.limits,
};

const store = (s?: SettingsStore): SettingsStore => s ?? localStorage;

/** Stored settings, or the defaults when none / unreadable / invalid. Never throws. */
export function loadVisitorSettings(s?: SettingsStore): VisitorSettings {
  try {
    const raw = store(s).getItem(SETTINGS_KEY);
    const r = raw ? VisitorSettingsSchema.safeParse(JSON.parse(raw)) : null;
    return r?.success ? r.data : DEFAULT_VISITOR_SETTINGS;
  } catch {
    return DEFAULT_VISITOR_SETTINGS;
  }
}

/** Validates (throws ZodError for the form) then saves. */
export function saveVisitorSettings(v: unknown, s?: SettingsStore): VisitorSettings {
  const out = VisitorSettingsSchema.parse(v);
  store(s).setItem(SETTINGS_KEY, JSON.stringify(out));
  return out;
}

/** The full core settings sizeTrade / pass1 / checkOrder expect. */
export const toAppSettings = (v: VisitorSettings): AppSettings => ({ ...DEFAULT_APP_SETTINGS, bankroll: v.bankroll, kelly: v.kelly, limits: v.limits });
