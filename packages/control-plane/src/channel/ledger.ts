import { eq, lte, sql } from "drizzle-orm";
import type { DurableDb } from "../db/client.ts";
import * as hostSchema from "../db/host-schema.ts";
import {
  accept,
  emptyLedger,
  type Frame,
  type HostMessage,
  type Ledger,
  type LedgerStore,
  type StoredControlMessage,
} from "./protocol.ts";

const { ledger: hostLedger, refusedFrames } = hostSchema;

export type HostDb = DurableDb<typeof hostSchema>;

type Held = { frame: Frame<unknown>; message: HostMessage | null; forwarded: boolean };

export class HostLedger implements LedgerStore<StoredControlMessage> {
  readonly #db: HostDb;
  #held: Held[] = [];
  #stalled = { seq: 0, tries: 0 };
  #refused: Set<number> | null = null;

  constructor(db: HostDb) {
    this.#db = db;
  }

  load(): Ledger<StoredControlMessage> {
    const row = this.#db.select().from(hostLedger).where(eq(hostLedger.ledgerId, 1)).get();
    if (row === undefined) return emptyLedger();
    return { received: row.received, sent: row.sent, unacked: JSON.parse(row.unacked) };
  }

  save(ledger: Ledger<StoredControlMessage>): void {
    const first = this.first();
    const received = first === null ? ledger.received : Math.min(ledger.received, first - 1);
    const refused = this.refused();
    if ([...refused].some((seq) => seq <= received)) {
      this.#db.delete(refusedFrames).where(lte(refusedFrames.seq, received)).run();
      for (const seq of refused) if (seq <= received) refused.delete(seq);
    }
    const unacked = JSON.stringify(ledger.unacked);
    this.#db
      .insert(hostLedger)
      .values({ ledgerId: 1, received, sent: ledger.sent, unacked })
      .onConflictDoUpdate({
        target: hostLedger.ledgerId,
        set: { received, sent: ledger.sent, unacked },
        setWhere: sql`${hostLedger.received} IS NOT ${received} OR ${hostLedger.sent} IS NOT ${ledger.sent} OR ${hostLedger.unacked} IS NOT ${unacked}`,
      })
      .run();
  }

  heard(): number {
    const last = this.#held.at(-1);
    if (last !== undefined) return last.frame.seq;
    return this.load().received;
  }

  skip(frame: Frame<unknown>): void {
    if (this.#held.length > 0) {
      this.#db
        .insert(refusedFrames)
        .values({ seq: frame.seq })
        .onConflictDoNothing({ target: refusedFrames.seq })
        .run();
      this.refused().add(frame.seq);
      return;
    }
    const outcome = accept(this.load(), frame, this.refused());
    if (outcome.kind !== "Accepted")
      throw new Error(`frame ${frame.seq} was skipped but the ledger no longer takes it`);
    this.save(outcome.ledger);
  }

  refused(): Set<number> {
    this.#refused ??= new Set(
      this.#db
        .select({ seq: refusedFrames.seq })
        .from(refusedFrames)
        .all()
        .map((row) => row.seq),
    );
    return this.#refused;
  }

  hold(frame: Frame<HostMessage>, forwarded: boolean): void {
    this.#held.push({ frame, message: frame.message, forwarded });
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

  first(): number | null {
    return this.#held[0]?.frame.seq ?? null;
  }

  take(): Frame<unknown>[] {
    const held = this.#held.map((each) => each.frame);
    this.#held = [];
    this.#stalled = { seq: 0, tries: 0 };
    return held;
  }

  stalled(): number {
    const first = this.first();
    if (first === null) return 0;
    this.#stalled = { seq: first, tries: this.#stalled.seq === first ? this.#stalled.tries + 1 : 1 };
    return this.#stalled.tries;
  }
}
