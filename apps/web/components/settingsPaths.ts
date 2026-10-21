// Dotted-path helpers behind the settings forms (Settings and Autonomy save slices of one AppSettings through PUT /api/settings, which deep-merges).

export const getAt = (o: unknown, path: string): unknown => path.split(".").reduce<any>((x, k) => x?.[k], o);

export function setAt<T>(o: T, path: string, v: unknown): T {
  const n = structuredClone(o) as any, ks = path.split(".");
  let c = n;
  for (const k of ks.slice(0, -1)) c = c[k] ??= {};
  c[ks[ks.length - 1]!] = v;
  return n;
}

/** Nested object with only `paths` from `o`: the PUT body for one group. */
export const pickPaths = (o: unknown, paths: readonly string[]): Record<string, unknown> => paths.reduce<Record<string, unknown>>((a, p) => setAt(a, p, getAt(o, p)), {});

export const samePaths = (a: unknown, b: unknown, paths: readonly string[]) => paths.every((p) => JSON.stringify(getAt(a, p)) === JSON.stringify(getAt(b, p)));

/** `into` with `paths` copied from `from`: after a group saves, its fields take the server values and other unsaved edits stay. */
export const copyPaths = <T>(into: T, from: unknown, paths: readonly string[]): T => paths.reduce((x, p) => setAt(x, p, getAt(from, p)), into);

/** Zod issue paths -> `a.b.c` keys for the field error lines. */
export const issueMap = (issues: { path: (string | number)[]; message: string }[]) => Object.fromEntries(issues.map((i) => [i.path.join("."), i.message]));
