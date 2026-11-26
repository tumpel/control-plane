# Storage

`doc/adr/010-bulk-data-out-of-the-database.md` holds the decision and its reasons.

1. The database holds metadata only: keys, digests, sizes and counts. Bulk data lives in R2: chunk, block and pack lists, manifests, transcripts and backups.
2. A table holds a fixed, small number of rows per entity. Never add a table with one row per chunk, file, pack or item of an unbounded list. Write the list to an R2 object, and keep its key, digest, size and count in SQL.
3. Write only the rows an operation needs. Every storage path has a rows-written bound, and a scenario test asserts it.
4. Every retry backs off exponentially and fails hard after 10 retries.
5. Every endpoint has a limit. Every write endpoint caps what one request writes.
6. Cost is a signal (tenet 9). A rising bill is a design fault to fix.
7. Durable information, meaning what must survive a restart, never lives in process memory, such as a Worker or Durable Object variable, or in a flat file. A local database is the minimum. Bulk data stays in R2 under rule 1.

## Queries

Drizzle is the only query route. `npm run db:schema` derives `src/db/*-schema.ts` from the migrations, and `npm run lint` fails when a migration changes and its schema file does not. Build a handle with `centralDb(env.DB)` or `durableDb(storage, schema)` from `src/db/client.ts`.

The Biome plugin `npm-scripts/biome-plugins/no-sql-exec.grit` fails `npm run lint` on any `sql.exec` call in `packages/control-plane/src`. The files that still hold raw SQL are excluded from it in `biome.json`. The excluded files are unchecked. The change that removes a file's last `sql.exec` also removes the file from the list. No file joins it.

A new migration that adds a TEXT or BLOB column carries a `-- bulk-data-reviewed: <reason>` comment, or `npm-scripts/migration-check.mjs` fails `npm run lint`.
