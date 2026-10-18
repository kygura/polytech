import { AppSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from "@pm/core";
import { schema as s, type Db } from "@pm/db";

const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
/** Objects merge key by key; arrays and scalars replace. `overrides`/`models` are open maps, so patch keys win. */
const merge = (base: any, patch: any): any =>
  plain(base) && plain(patch) ? { ...base, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, merge(base[k], v)])) } : (patch ?? base);

export async function getSettings(db: Db): Promise<AppSettings> {
  const row = (await db.select().from(s.settings).limit(1))[0];
  return AppSettingsSchema.parse(merge(DEFAULT_APP_SETTINGS, row?.data)) as AppSettings;
}

/** Deep-merges `patch` onto the stored settings, validates, saves. Throws ZodError on bad input (nothing saved). */
export async function putSettings(db: Db, patch: unknown): Promise<AppSettings> {
  const next = AppSettingsSchema.parse(merge(await getSettings(db), patch)) as AppSettings;
  await db.insert(s.settings).values({ id: 1, data: next }).onConflictDoUpdate({ target: s.settings.id, set: { data: next } });
  return next;
}

export { DEFAULT_APP_SETTINGS, type AppSettings };
