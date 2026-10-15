import { z } from "zod";

const DROP = new Set(["minimum", "maximum", "minLength", "maxLength", "format", "pattern", "exclusiveMinimum", "exclusiveMaximum", "$schema"]);

/** zod -> JSON schema acceptable to structured outputs (no min/max/format; zod re-validates after). */
export function jsonSchema(s: z.ZodType): Record<string, unknown> {
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.has(k)).map(([k, x]) => [k, strip(x)]))
        : v;
  return strip(z.toJSONSchema(s)) as Record<string, unknown>;
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
