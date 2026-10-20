import { closeDb, migrate } from "./client";

await migrate();
console.log("migrated");
await closeDb();
