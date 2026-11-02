import { sql, type SQL } from "drizzle-orm";

// SQLite (libSQL / Turso) expression helpers shared by the schema, kv and the app's raw queries.

/** Current time in epoch ms on the database clock (julianday keeps the milliseconds; plain unixepoch() drops them). */
export const nowMs: SQL = sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`;
