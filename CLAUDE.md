# CLAUDE.md

## Datastore

The app's only datastore is Redis (Upstash in production), through the row store in `packages/db` (read `packages/db/README.md`
before touching data access). There are no SQL migrations.

- Tables, columns and indexes live in `packages/db/src/schema.ts`. Every filtered read goes through an index declared there
  (or a full scan on the small tables the README lists); there is no query planner, so add the index with the query.
- A new or changed index only covers rows written after it exists. After merging one, run `cd packages/db && bun run db:reindex <table>`
  against production (with the production `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` in the env), then say so in the reply.
  Reindex is additive and safe while the app runs. If production credentials are not available, say that it still needs to run.
- New columns need nothing: old rows read the column's default (or null).
- Compare-and-set, uniqueness and multi-row atomicity come from the store (`update` with a predicate function, unique constraints,
  `db.tx`). Keep side effects out of `update`/`upsert` functions and `db.tx` bodies: they re-run on conflict.
- Production runs on Upstash REST: each store call is one HTTP round trip. Batch with `getMany`/`findEach`/`idsEach` instead of
  looping, and never `all()` the history tables (snapshots, screens, agentRuns, evidence, fills, alerts, orders, positions).
- Tests use the in-process backend automatically. The store conformance suite also runs on real Redis when `REDIS_TEST_URL` is set
  (CI does this): `redis-server --port 6390 --save '' --daemonize yes` and `REDIS_TEST_URL=redis://127.0.0.1:6390 bun run test` in `packages/db`.
