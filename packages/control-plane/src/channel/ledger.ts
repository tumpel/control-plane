import {
  emptyLedger,
  type Frame,
  type HostMessage,
  type Ledger,
  type LedgerStore,
  type StoredControlMessage,
} from "./protocol.ts";

type LedgerSql = {
  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
};

const HELD_FRAMES = 1000;
const HELD_BYTES = 1_000_000;

export class HostLedger implements LedgerStore<StoredControlMessage> {
  readonly #sql: LedgerSql;
  #held: Frame<HostMessage>[] = [];
  #heldBytes = 0;

  constructor(sql: LedgerSql) {
    this.#sql = sql;
  }

  load(): Ledger<StoredControlMessage> {
    const [row] = this.#sql
      .exec<{ received: number; sent: number; unacked: string }>(
        "SELECT received, sent, unacked FROM ledger WHERE ledger_id = 1",
      )
      .toArray();
    if (row === undefined) return emptyLedger();
    return { received: row.received, sent: row.sent, unacked: JSON.parse(row.unacked) };
  }

  save(ledger: Ledger<StoredControlMessage>): void {
    const first = this.#held[0];
    this.#sql.exec(
      `INSERT INTO ledger (ledger_id, received, sent, unacked) VALUES (1, ?, ?, ?)
      ON CONFLICT (ledger_id) DO UPDATE SET received = excluded.received, sent = excluded.sent, unacked = excluded.unacked
      WHERE ledger.received IS NOT excluded.received OR ledger.sent IS NOT excluded.sent OR ledger.unacked IS NOT excluded.unacked`,
      first === undefined ? ledger.received : Math.min(ledger.received, first.seq - 1),
      ledger.sent,
      JSON.stringify(ledger.unacked),
    );
  }

  heard(): number {
    const last = this.#held.at(-1);
    if (last !== undefined) return last.seq;
    const [row] = this.#sql.exec<{ received: number }>("SELECT received FROM ledger WHERE ledger_id = 1").toArray();
    return row?.received ?? 0;
  }

  hold(frame: Frame<HostMessage>, bytes: number): boolean {
    this.#held.push(frame);
    this.#heldBytes += bytes;
    return this.#held.length >= HELD_FRAMES || this.#heldBytes >= HELD_BYTES;
  }

  holding(): boolean {
    return this.#held.length > 0;
  }

  take(): Frame<HostMessage>[] {
    const held = this.#held;
    this.#held = [];
    this.#heldBytes = 0;
    return held;
  }
}
