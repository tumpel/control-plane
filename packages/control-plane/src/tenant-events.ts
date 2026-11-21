import { type ListEventsInputSchema, type ListEventsResultSchema, TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { storedEvent } from "./bounded-detail.ts";

type TenantEvent = z.infer<typeof TenantEventSchema>;

type Envelope = "eventId" | "tenantId" | "createdAt";
export type NewTenantEvent = TenantEvent extends infer E ? (E extends TenantEvent ? Omit<E, Envelope> : never) : never;
type ListEventsInput = z.infer<typeof ListEventsInputSchema>;
type Listed = z.infer<typeof ListEventsResultSchema>["listed"];

export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

export const appendEvent = (sql: SqlStorage, event: NewTenantEvent, now: number): number => {
  const [row] = sql
    .exec<{ event_id: number }>(
      "INSERT INTO events (payload, created_at) VALUES (?, ?) RETURNING event_id",
      JSON.stringify(event),
      now,
    )
    .toArray();
  if (row === undefined) throw new Error(`the events table returned no id for a ${event.event} event`);
  if ("sessionId" in event) {
    sql.exec(
      "INSERT INTO event_sessions (event_id, session_id, tags) VALUES (?, ?, (SELECT json_group_array(tag) FROM session_tags WHERE session_id = ?))",
      row.event_id,
      event.sessionId,
      event.sessionId,
    );
  }
  sql.exec("DELETE FROM events WHERE created_at < ?", now - EVENT_RETENTION_MS);
  return row.event_id;
};

export const endOfLog = (sql: SqlStorage): number =>
  sql.exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'").toArray()[0]?.seq ?? 0;

export const oldestKept = (sql: SqlStorage, end: number): number =>
  sql.exec<{ oldest: number | null }>("SELECT MIN(event_id) AS oldest FROM events").one().oldest ?? end + 1;

type EventRow = { event_id: number; payload: string; created_at: number };

export const listEvents = (sql: SqlStorage, input: ListEventsInput): Listed => {
  if (input.waitSeconds !== 0) {
    throw new Error(
      `listEvents got waitSeconds ${input.waitSeconds}; the tenant Durable Object never waits, the Worker waits on the event channel`,
    );
  }
  const end = endOfLog(sql);
  const after = input.afterEventId;
  if (after === null) return { kind: "Read", page: { events: [], lastEventId: end } };
  const oldest = oldestKept(sql, end);
  if (after < oldest - 1) return { kind: "CursorExpired", oldestEventId: oldest };
  const rows = sql
    .exec<EventRow>(
      `SELECT events.event_id, events.payload, events.created_at FROM events
        WHERE events.event_id > ?1
          AND (?2 = 0 OR json_extract(events.payload, '$.event') IN (SELECT value FROM json_each(?3)))
          AND (?4 IS NULL OR EXISTS (SELECT 1 FROM event_sessions
                WHERE event_sessions.event_id = events.event_id AND event_sessions.session_id = ?4))
          AND (?6 IS NULL OR json_extract(events.payload, '$.triggerId') = ?6)
        ORDER BY events.event_id LIMIT ?5`,
      after,
      input.events.length,
      JSON.stringify(input.events),
      input.sessionId,
      PAGE_SIZE,
      input.triggerId,
    )
    .toArray();
  const events = rows.map((row) =>
    TenantEventSchema.parse({
      ...storedEvent(row.payload),
      eventId: row.event_id,
      tenantId: input.tenantId,
      createdAt: row.created_at,
    }),
  );
  const last = rows.at(-1);
  const lastEventId = rows.length === PAGE_SIZE && last !== undefined ? last.event_id : Math.max(end, after);
  return { kind: "Read", page: { events, lastEventId } };
};
