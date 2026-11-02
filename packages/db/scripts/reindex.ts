/** bun run db:reindex [table...]: add existing rows to the indexes/unique constraints in schema.ts. Uses the store from the env (see README). */
import { closeDb, getDb } from "../src/client";
import { reindex } from "../src/maintenance";

const report = await reindex(getDb(), process.argv.slice(2));
for (const r of report) console.log(`${r.table}: ${r.rows} rows${r.uniqueConflicts.length ? `, unique conflicts: ${r.uniqueConflicts.join(", ")}` : ""}`);
await closeDb();
