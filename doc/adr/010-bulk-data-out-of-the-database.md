# 010. The database holds metadata, and bulk data lives in R2

Status: accepted

On 2026-11-20 the tenant Durable Objects wrote about 125M rows, and the day billed $126. Tenant migration 0013, shipped on 2026-11-15, gave snapshot storage one row per chunk in `chunks`, `session_chunks` and `snapshot_uploads`. Migrations 0015 and 0070 added `packs`, `snapshot_packs`, `snapshot_chunks` and `snapshot_manifest_chunks`, each with one row per chunk or pack. Every stored snapshot records each chunk its manifest names ([EDD-004](https://github.com/tumpel/.github/blob/main/docs/004-snapshots-and-transcripts.md)), and a snapshot follows every turn ([ADR-008](008-snapshot-after-every-turn.md)). Retries in tenant alarms and deliveries had no cap (#78).

Tenant SQL holds a fixed, small number of rows per entity: keys, digests, sizes and counts. No table holds one row per chunk, file, pack or item of an unbounded list. Chunk, block and pack lists, manifests, transcripts and backups live in R2. A snapshot is one row that points at its root and manifest in R2. Every storage path has a rows-written bound, and a scenario test proves it. Every retry backs off exponentially and fails hard after 10 retries. Every endpoint has a limit, and every write endpoint caps what one request writes. The owner's rules, verbatim:

> database always only holds metadata. Anything that is larger than a few bytes should move into blob.
>
> make writes cheap. We don't want to write any more than we have to.
>
> All retries follow the following pattern. Exponential back off and a maximum of 10 retries, then hard failure.
>
> all endpoints to have limits, especially write endpoints
>
> We treat cost as a signal.

This applies tenet 9 and adds tenet 10. The cost is that a lookup by chunk digest reads a manifest from R2, and retention can no longer find an unreferenced pack with a join. The gain is that a snapshot writes the same few rows whatever the size of its tree, and the bill grows with sessions and turns instead of files. `rules/storage.md` gives the rules for agents.

## Amendment: pack reference counts

Status: accepted, 2026-11-25

Retention keeps one count per pack in tenant SQL, the one exception to "no table holds one row per pack". `pack_refs` holds one row per live pack: its digest and the number of live `snapshots` rows whose pack list names it, plus the number of sessions that hold it. `pack_holds` holds one row per pack of an upload in flight. Only a `snapshots` row carries references; a pack list in R2 without a row carries none.

The bound: the `pack_refs` rows one frame writes equal the packs whose net count changes, and the `pack_holds` rows it writes equal the packs its upload adds or releases. A stored snapshot commits its row, the deletion of the rows it releases, the release of its session's holds and the net change of each pack in one transaction, so a snapshot that reuses a pack writes no row for it. A pack whose count reaches 0 keeps its row until R2 deletes the pack. Rows grow with live packs, never with chunks, files or turns.

A tenant's one-time import of its `live-packs.json` object reconciles it against the `snapshots` rows and writes its rows and an imported marker in one transaction, so it runs once.
