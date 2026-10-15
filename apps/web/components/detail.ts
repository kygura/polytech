import type { read } from "../lib/jobs";

/** The /markets/[id] payload; composites take slices of it. */
export type Detail = NonNullable<Awaited<ReturnType<typeof read.marketDetail>>>;
