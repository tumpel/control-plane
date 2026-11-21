# Storage

`doc/adr/010-bulk-data-out-of-the-database.md` holds the decision and its reasons.

1. The database holds metadata only: keys, digests, sizes and counts. Bulk data lives in R2: chunk, block and pack lists, manifests, transcripts and backups.
2. A table holds a fixed, small number of rows per entity. Never add a table with one row per chunk, file, pack or item of an unbounded list. Write the list to an R2 object, and keep its key, digest, size and count in SQL.
3. Write only the rows an operation needs. Every storage path has a rows-written bound, and a scenario test asserts it.
4. Every retry backs off exponentially and fails hard after 10 retries.
5. Every endpoint has a limit. Every write endpoint caps what one request writes.
6. Cost is a signal (tenet 9). A rising bill is a design fault to fix.

## Queries

Drizzle is the only query route. `npm run db:schema` derives `src/db/*-schema.ts` from the migrations, and `npm run lint` fails when a migration changes and its schema file does not. Build a handle with `centralDb(env.DB)` or `durableDb(storage, schema)` from `src/db/client.ts`.

`npm run lint` runs `npm-scripts/sql-check.mjs`. It finds every remaining hand-written SQL site under `packages/*/src` and fails on one that is not in `npm-scripts/sql-allowlist.json`, and on an allowlisted site that no longer exists. It also fails when any file holds more sites than on the base branch (`origin/main`, or `origin/$GITHUB_BASE_REF` in CI). `npm run sql:update` only removes entries. The allowlist only shrinks.

A new migration that adds a TEXT or BLOB column carries a `-- bulk-data-reviewed: <reason>` comment, or the check fails.
