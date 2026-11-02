// Vercel build step (apps/web/vercel.json buildCommand), run before `turbo run build` so a turbo cache hit can't skip it.
// Production builds apply pending migrations to the hosted Turso database. Preview builds share that database, so they never migrate.
import { closeDb, hostedDb, migrate } from "@pm/db";

const env = process.env.VERCEL_ENV;
if (env === "production" && hostedDb()) {
  await migrate();
  await closeDb();
  console.log("db: migrations applied to the hosted database");
} else console.log(`db: migrate skipped (VERCEL_ENV=${env ?? "unset"}, hosted=${hostedDb()})`);
