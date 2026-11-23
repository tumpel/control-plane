import { eq, sql } from "drizzle-orm";
import type { DurableDb } from "../db/client.ts";
import * as hostSchema from "../db/host-schema.ts";
import { emptyLedger, type Ledger, type LedgerStore, type StoredControlMessage } from "./protocol.ts";

const { ledger: hostLedger } = hostSchema;

export type HostDb = DurableDb<typeof hostSchema>;

export class HostLedger implements LedgerStore<StoredControlMessage> {
  readonly #db: HostDb;

  constructor(db: HostDb) {
    this.#db = db;
  }

  load(): Ledger<StoredControlMessage> {
    const row = this.#db.select().from(hostLedger).where(eq(hostLedger.ledgerId, 1)).get();
    if (row === undefined) return emptyLedger();
    return { sent: row.sent, unacked: JSON.parse(row.unacked) };
  }

  save(ledger: Ledger<StoredControlMessage>): void {
    const { sent } = ledger;
    const unacked = JSON.stringify(ledger.unacked);
    this.#db
      .insert(hostLedger)
      .values({ ledgerId: 1, received: 0, sent, unacked })
      .onConflictDoUpdate({
        target: hostLedger.ledgerId,
        set: { sent, unacked },
        setWhere: sql`${hostLedger.sent} IS NOT ${sent} OR ${hostLedger.unacked} IS NOT ${unacked}`,
      })
      .run();
  }
}
