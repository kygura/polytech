// One-off copy of the old Postgres (Supabase) data into the libSQL database: Turso when TURSO_DATABASE_URL is set, else the local file.
//   cd packages/db && PG_URL=<Supabase session-pooler or direct url> TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... bun run db:copy-from-postgres
// Migrates the target, then copies every schema table found in Postgres (referenced tables first) with ON CONFLICT DO NOTHING, so a rerun
// only adds what is missing. Run it before the app writes to the target: a Postgres row whose id is already taken there is skipped.
// Ends with row counts per table and exits 1 if any target table has fewer rows than its source.
import { getTableConfig } from "drizzle-orm/sqlite-core";
import postgres from "postgres";
import { closeDb, migrate } from "../src/client";
import { convertRows, insertRows, rowsPerChunk, tablesInFkOrder } from "./convert";

const pgUrl = process.env.PG_URL;
if (!pgUrl) {
  console.error("PG_URL required: the Postgres connection string (Supabase: session pooler or direct, not the transaction pooler)");
  process.exit(1);
}
const turso = process.env.TURSO_DATABASE_URL;
console.log(`target: ${turso ? new URL(turso).host : `local file ${process.env.DB_FILE ?? ".data/polytech.db"}`}`);

const pg = postgres(pgUrl, { prepare: false, max: 1, onnotice: () => {} });
const db = await migrate();
const report: { table: string; source: number | "absent"; before: number; inserted: number; after: number }[] = [];
try {
  for (const table of tablesInFkOrder()) {
    const name = getTableConfig(table).name;
    const before = await db.$count(table);
    const [found] = await pg`select 1 from information_schema.tables where table_schema = 'public' and table_name = ${name}`;
    if (!found) {
      console.warn(`${name}: not in Postgres, skipped`);
      report.push({ table: name, source: "absent", before, inserted: 0, after: before });
      continue;
    }
    const source = (await pg<{ n: number }[]>`select count(*)::int as n from ${pg(name)}`)[0]?.n ?? 0;
    const dropped = new Set<string>(), missing = new Set<string>(), nonFinite = new Set<string>();
    let inserted = 0;
    for await (const batch of pg`select * from ${pg(name)}`.cursor(rowsPerChunk(table))) {
      const c = convertRows(table, batch);
      c.dropped.forEach((k) => dropped.add(k));
      c.missing.forEach((k) => missing.add(k));
      c.nonFinite.forEach((k) => nonFinite.add(k));
      inserted += await insertRows(db, table, c.rows);
    }
    if (dropped.size) console.warn(`${name}: Postgres columns not in the schema, not copied: ${[...dropped].join(", ")}`);
    if (missing.size) console.warn(`${name}: schema columns not in Postgres, default or null: ${[...missing].join(", ")}`);
    if (nonFinite.size) console.warn(`${name}: NaN/Infinity stored as null in: ${[...nonFinite].join(", ")}`);
    console.log(`${name}: ${source} rows in Postgres, ${inserted} inserted`);
    report.push({ table: name, source, before, inserted, after: await db.$count(table) });
  }
} finally {
  await pg.end();
  await closeDb();
}
console.table(report);
const short = report.filter((l) => typeof l.source === "number" && l.after < l.source);
if (short.length) console.error(`fewer rows than Postgres in: ${short.map((l) => l.table).join(", ")}`);
process.exit(short.length ? 1 : 0);
