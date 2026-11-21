import {
  accept,
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

type Held = { frame: Frame<unknown>; message: HostMessage | null; forwarded: boolean; bytes: number };

const HELD_FRAMES = 1000;
const HELD_BYTES = 1_000_000;

export class HostLedger implements LedgerStore<StoredControlMessage> {
  readonly #sql: LedgerSql;
  #held: Held[] = [];

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
    const first = this.first();
    this.#sql.exec(
      `INSERT INTO ledger (ledger_id, received, sent, unacked) VALUES (1, ?, ?, ?)
      ON CONFLICT (ledger_id) DO UPDATE SET received = excluded.received, sent = excluded.sent, unacked = excluded.unacked
      WHERE ledger.received IS NOT excluded.received OR ledger.sent IS NOT excluded.sent OR ledger.unacked IS NOT excluded.unacked`,
      first === null ? ledger.received : Math.min(ledger.received, first - 1),
      ledger.sent,
      JSON.stringify(ledger.unacked),
    );
  }

  heard(): number {
    const last = this.#held.at(-1);
    if (last !== undefined) return last.frame.seq;
    return this.load().received;
  }

  skip(frame: Frame<unknown>): void {
    if (this.#held.length > 0) {
      this.#held.push({ frame, message: null, forwarded: true, bytes: 0 });
      return;
    }
    const outcome = accept(this.load(), frame);
    if (outcome.kind !== "Accepted")
      throw new Error(`frame ${frame.seq} was skipped but the ledger no longer takes it`);
    this.save(outcome.ledger);
  }

  hold(frame: Frame<HostMessage>, forwarded: boolean, bytes: number): void {
    this.#held.push({ frame, message: frame.message, forwarded, bytes });
  }

  holding(): boolean {
    return this.#held.length > 0;
  }

  queued(): Frame<HostMessage>[] {
    return this.#held.flatMap((held) =>
      held.message === null || held.forwarded ? [] : [{ ...held.frame, message: held.message }],
    );
  }

  forwarded(seq: number): void {
    for (const held of this.#held) if (held.frame.seq === seq) held.forwarded = true;
  }

  requeue(): void {
    for (const held of this.#held) if (held.message !== null) held.forwarded = false;
  }

  full(): boolean {
    return this.#held.length >= HELD_FRAMES || this.#held.reduce((bytes, held) => bytes + held.bytes, 0) >= HELD_BYTES;
  }

  first(): number | null {
    return this.#held[0]?.frame.seq ?? null;
  }

  take(): Frame<unknown>[] {
    const held = this.#held.map((each) => each.frame);
    this.#held = [];
    return held;
  }
}
