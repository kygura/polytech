# @pm/db

The app's datastore is Redis. `src/schema.ts` declares the tables; `src/store/` is a small row store on top of Redis
(rows, sorted-set indexes, unique constraints, optimistic transactions). Kv (`getKv()`: locks, rate limits, small values)
lives in the same Redis under its own keys.

## Backends

`getDb()` picks one from the environment:

| env | backend |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel's `KV_REST_API_URL` + `KV_REST_API_TOKEN`) | Upstash over REST. Production on Vercel. |
| `REDIS_URL` | any Redis 6.2+ / Valkey over TCP (ioredis): self-hosted, local `redis-server`, CI |
| neither | in-process, saved to `<repo>/.data/store.json` (`STORE_FILE` overrides; `memory://` saves nothing, the default under vitest). Refused in production on Vercel. One process per file. |

`REDIS_PREFIX` (default `{pm}:`) namespaces the keys, so several environments can share one Redis. Keep a `{hash tag}` in
it: the Lua scripts touch many keys at once, and a hash tag keeps them in one cluster slot.

## Layout in Redis

```
{pm}:t:<table>        hash   pk -> "<version>|<row json>"
{pm}:i:<table>:<index>:<values>   zset   member = pk, score = sort field (ms for dates; 0 = pk order)
{pm}:u:<table>:<constraint>       hash   unique value -> pk
{pm}:seq:<table>      string serial id sequence
{pm}:ver              string commit counter (row versions)
```

Each read is one Lua script (one round trip). A write commits as one Lua script that checks the versions it was computed
from, checks unique values, then writes rows and index entries together, so a commit is atomic.

## API

```ts
import { getDb, schema as s, UniqueViolation, type Db } from "@pm/db";
const db = getDb();

// rows: the same shapes as before (typeof s.markets.$inferSelect / $inferInsert); every column present, null when unset
await db.markets.get(conditionId);                 // row | null
await db.markets.getMany(ids);                     // rows that exist, in input order
await db.markets.all();                            // full scan: small tables only
await db.rrCache.get([conditionId, rulesHash]);    // composite keys are tuples (schema `pk` order)

// indexes (declared per table in schema.ts): equality on `on` fields, range/order on `sort`
await db.snapshots.find("cond", { conditionId }, { order: "desc", limit: 1 });
await db.snapshots.find("cond", { conditionId }, { min: since, lt: until });  // min/max inclusive, gt/lt exclusive; numbers or Dates
await db.orders.find("bookStatus", [{ paper: false, status: "live" }, { paper: false, status: "sending" }]); // IN: partitions merged by sort field
await db.snapshots.findEach("cond", ids.map((conditionId) => ({ conditionId })), { order: "desc", limit: 1 }); // per-id results, batched
await db.snapshots.first("byTs", {}, { order: "desc" }); // newest row overall, or null
await db.pods.count("status", { status: "running" });
await db.alerts.ids("unacked", {});                // pks only
await db.theses.distinct("cond");                  // values of a one-field index that hold rows
await db.views.byUnique("name", { name });         // row holding a unique value

// writes (each is its own transaction)
await db.alerts.insert({ kind, message });         // serial ids and defaults filled; throws UniqueViolation on a taken key/unique value
await db.snapshots.insertMany(rows);               // atomic per ~200-row chunk
await db.fills.insertIfAbsent(row);                // ON CONFLICT DO NOTHING: row or null
await db.marketFlags.upsert({ conditionId, pinned: true });                 // insert, or patch with the inserted values
await db.spend.upsert({ day, anthropicUsd: usd }, (cur) => ({ anthropicUsd: cur.anthropicUsd + usd })); // atomic increment
await db.views.upsertBy("name", { id: randomUUID(), name, query });        // ON CONFLICT (name) DO UPDATE
await db.markets.update(id, { status: "closed" });                          // patch; null if the row is missing
await db.proposals.update(id, (r) => (r.status === "pending" ? { status: "approved" } : null)); // compare-and-set: null = lost/no-op
await db.orders.updateMany(ids, (r) => (r.status === "live" ? { status: "cancelled" } : null)); // per-row CAS, atomic per chunk
await db.pods.delete(id); await db.screens.deleteMany(ids, (r) => r.ts < cutoff);

// multi-row, multi-table atomic transaction (optimistic: fn re-runs on conflict, so no side effects inside)
await db.tx(async (tx) => {
  const p = await tx.proposals.get(id);
  if (p?.status !== "pending") return null;
  await tx.proposals.update(id, { status: "approved" });
  await tx.orders.insert({ ... });
});
```

A function passed to `update`/`upsert`/`updateMany` sees the current row and may run more than once under contention;
returning `null`/`false`/`undefined` means "no change". That is how a Postgres `update ... where id = ? and status = X returning`
compare-and-set ports: exactly one concurrent caller gets the row back.

Index reads (`find`, `all`, `count`, `ids`) inside `db.tx` read committed data and do not see the transaction's own writes.

Postgres features with no direct equivalent are done in code: joins (fetch both sides, join in a Map), `group by`/`sum`/`count`/`max`
(reduce in JS, or `count`/`first` on an index), `distinct on` (`findEach(..., { order: "desc", limit: 1 })`), `not exists` (look the
other side up by index). Postgres orders `NULL` first on `desc`; index sorts put null scores first ascending, so last on `desc`.
Code that needs the Postgres order sorts explicitly.

## Schema changes

There are no migrations: rows are JSON, and a column added to `schema.ts` reads as its default (or null) on old rows.
A new or changed index only covers rows written after it exists; run `bun run db:reindex` once per store to add old rows to it.
Removing a column needs nothing; stale fields are ignored on read and dropped on the next write.

## Scripts

- `bun run db:reindex [table...]`: add every row to the indexes and unique constraints in `schema.ts` (idempotent, safe online).
- `bun run db:import-pg`: copy a Postgres database built from the old Drizzle schema (`PG_URL`) into the configured store. See the script header.
