import { defineConfig } from "drizzle-kit";

// Turso (libSQL). `generate` needs no database; `drizzle-kit migrate/studio` read TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, else the local file.
export default defineConfig({
  dialect: "turso",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.TURSO_DATABASE_URL ?? `file:${process.env.DB_FILE ?? "../../.data/polytech.db"}`, authToken: process.env.TURSO_AUTH_TOKEN },
});
