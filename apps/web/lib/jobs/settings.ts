import { AppSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from "@pm/core";
import type { Db } from "@pm/db";

const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
/** Objects merge key by key; arrays and scalars replace. `overrides`/`models` are open maps, so patch keys win. */
const merge = (base: any, patch: any): any =>
  plain(base) && plain(patch) ? { ...base, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, merge(base[k], v)])) } : (patch ?? base);

const parse = (data: unknown) => AppSettingsSchema.parse(merge(DEFAULT_APP_SETTINGS, data)) as AppSettings;

export async function getSettings(db: Db): Promise<AppSettings> {
  return parse((await db.settings.get(1))?.data); // single row, id 1
}

/** Deep-merges `patch` onto the stored settings, validates, saves. Throws ZodError on bad input (nothing saved). */
export async function putSettings(db: Db, patch: unknown): Promise<AppSettings> {
  // read-modify-write in one transaction: a concurrent put re-runs this on the newer row instead of being overwritten
  return db.tx(async (tx) => {
    const merged = merge(parse((await tx.settings.get(1))?.data), patch);
    // merge() lets a null patch fall back to the stored value; `suggested: null` must clear it (Settings refit Apply / Dismiss).
    if (plain(patch) && patch.suggested === null) merged.suggested = null;
    const next = AppSettingsSchema.parse(merged) as AppSettings;
    await tx.settings.upsert({ id: 1, data: next });
    return next;
  });
}

export { DEFAULT_APP_SETTINGS, type AppSettings };
