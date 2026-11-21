# 000. Tenets

Status: accepted

These tenets bind every decision in `doc/adr`, `doc/RFC` and `doc/EDD`, next to the tenets of [RFC: Tumpel](../RFC/RFC-TUM-Tumpel.md#tenets).

1. Fail fast. A failed operation fails once, loudly, with a reason that names what failed. Clients may retry a retryable status code (429, or 503 with `Retry-After`). The backend never retries a failing downstream resource unless a written plan says how that failure is handled, and such a plan is rare. Lint enforces this tenet.
2. No logic in the supervisor. The supervisor and the guest pass input through, and the control plane owns harness-specific behaviour. They run on hosts Tumpel does not own and update on their own schedule, so a feature that appears to need a supervisor change looks for a control-plane design first.
3. Tumpel relies on the harness's own features. It never reads or judges a harness transcript, for example to detect an early stop. The harness runs the agent loop, and Tumpel runs the harness.
4. No automatic triggers and no auto-detection. A prebuild runs only when a person or an external trigger starts it, and the user picks its template. The user decides what runs and when.
5. TypeSpec is the single source of truth. Generated output is never written by hand, so the API, the host channel and every config file share one definition.
6. Every input surface has a versioned schema: each API operation, MCP tool, CLI argument and config file. A tenant keeps its config in a file it installs, maintains or keeps in a git repo.
7. What can be created can be read back. Every resource and file written through the API reads back through the API, MCP and the CLI, and only secret values stay write-only. An MCP client edits a persona file only when it can read it.
8. CI time is priority zero. Every change keeps cutting it, measured in minutes per job before and after. Short feedback loops matter to agents as much as to people.
9. Cost is a signal. This means a rising bill points at a design problem, such as client polling, a held connection, an oversized box or overlapping builds, and the design changes until the bill falls. Live channels use the Durable Object WebSocket Hibernation API, so an idle connection bills nothing, and no Durable Object stays active while it waits. It does not mean choosing the cheapest design over one that works.
10. The database holds metadata only. Tenant SQL holds keys, digests, sizes and counts, in a fixed, small number of rows per entity. Bulk data lives in R2: chunk, block and pack lists, manifests, transcripts and backups. Writes are cheap and bounded. Every storage path writes only the rows it needs, and a scenario test proves its bound ([ADR-010](010-bulk-data-out-of-the-database.md)).
