import { CapacityRefusalCodeSchema, StartRefusalCodeSchema, StartRefusedEventSchema } from "@tumpel/schemas";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import { boundedTo } from "./bounded-detail.ts";
import { durableDb } from "./db/client.ts";
import { placed } from "./sessions.ts";
import type { NewTenantEvent } from "./tenant-events.ts";
import type { NewSession, SessionStarted, StartedSession } from "./tenant-sessions.ts";

type RefusalEvent = Omit<z.infer<typeof StartRefusedEventSchema>, "eventId" | "tenantId" | "createdAt">;
type Recipient = { subscriptionId: string; cursorEventId: number; eventId: number | null };
type Storage = Parameters<typeof durableDb>[0];

export const START_REFUSAL_EVENTS = `SELECT e.event_id, e.payload, e.created_at
  FROM events AS e JOIN subscription_start_refusals AS r ON r.event_id = e.event_id
  WHERE r.subscription_id = ?1 AND e.event_id > ?2`;

export const recordStartRefusal = (
  storage: Storage,
  event: RefusalEvent,
  callerSessionId: string | null,
  now: number,
  append: (event: NewTenantEvent, now: number) => number,
  queue: (subscriptionId: string, now: number) => void,
): void => {
  const db = durableDb(storage, {});
  const recipients = db.all<Recipient>(sql`SELECT s.subscription_id AS subscriptionId,
      s.cursor_event_id AS cursorEventId, r.event_id AS eventId
    FROM subscriptions AS s JOIN subscription_actives AS a ON a.subscription_id = s.subscription_id
    JOIN subscription_events AS listed ON listed.subscription_id = s.subscription_id AND listed.event = 'StartRefused'
    LEFT JOIN subscription_start_refusals AS r ON r.subscription_id = s.subscription_id AND r.code = ${event.refusal.code}
    WHERE s.session_id = ${callerSessionId} OR NOT EXISTS (
      SELECT 1 FROM subscription_crew_tags AS c WHERE c.subscription_id = s.subscription_id
      AND c.tag NOT IN (SELECT value FROM json_each(${JSON.stringify(event.crewTags)})))
    ORDER BY s.subscription_id LIMIT 101`);
  if (recipients.length > 100) throw new Error("a refused start matched more than 100 subscriptions");
  const fresh = recipients.filter((row) => row.eventId === null || row.eventId <= row.cursorEventId);
  const capacity = CapacityRefusalCodeSchema.safeParse(event.refusal.code);
  const box =
    capacity.success && recipients.length > 0
      ? db.get<{ boxMemoryMib: number; boxDiskMib: number; harness: string }>(sql`SELECT
        box_memory_mib AS boxMemoryMib, box_disk_mib AS boxDiskMib, harness
        FROM personas WHERE persona_id = ${event.personaId}`)
      : undefined;
  if (capacity.success && recipients.length > 0 && box === undefined) {
    throw new Error(`refused start names missing persona ${event.personaId}`);
  }
  storage.transactionSync(() => {
    if (fresh.length > 0 || recipients.length === 0) {
      const eventId = append(event, now);
      for (const recipient of fresh) {
        db.run(sql`INSERT INTO subscription_start_refusals (subscription_id, code, event_id)
          VALUES (${recipient.subscriptionId}, ${event.refusal.code}, ${eventId})
          ON CONFLICT (subscription_id, code) DO UPDATE SET event_id = excluded.event_id`);
        queue(recipient.subscriptionId, now);
      }
    }
    if (!capacity.success || box === undefined) return;
    for (const recipient of recipients) {
      db.run(sql`INSERT INTO subscription_pending_room
        (subscription_id, code, persona_id, harness, harness_version, box_memory_mib, box_disk_mib, updated_at)
        VALUES (${recipient.subscriptionId}, ${capacity.data}, ${event.personaId}, ${box.harness},
          ${event.harnessVersion}, ${box.boxMemoryMib}, ${box.boxDiskMib}, ${now})
        ON CONFLICT (subscription_id) DO UPDATE SET code = excluded.code, persona_id = excluded.persona_id,
          harness = excluded.harness, harness_version = excluded.harness_version,
          box_memory_mib = excluded.box_memory_mib, box_disk_mib = excluded.box_disk_mib, updated_at = excluded.updated_at
        WHERE code != excluded.code OR persona_id != excluded.persona_id OR harness != excluded.harness
          OR harness_version != excluded.harness_version OR box_memory_mib != excluded.box_memory_mib
          OR box_disk_mib != excluded.box_disk_mib`);
    }
  });
};

export const recordSessionStartRefusal = (
  storage: Storage,
  input: NewSession,
  result: SessionStarted<StartedSession>,
  crewTags: string[],
  now: number,
  append: (event: NewTenantEvent, now: number) => number,
  queue: (subscriptionId: string, now: number) => void,
): void => {
  if (result.kind !== "Unplaced") return;
  const refusal = placed<StartedSession>(result);
  if (refusal.ok) return;
  const code = StartRefusalCodeSchema.safeParse(refusal.problem.code);
  if (!code.success) return;
  recordStartRefusal(
    storage,
    {
      event: "StartRefused",
      operation: "Start",
      refusal: {
        code: code.data,
        detail: boundedTo(StartRefusedEventSchema.shape.refusal.shape.detail.maxLength, refusal.problem.detail),
      },
      personaId: input.start.personaId,
      model: input.start.model,
      harnessVersion: input.harnessVersion,
      crewTags,
    },
    input.startedBy.kind === "Turn" ? input.startedBy.sessionId : null,
    now,
    append,
    queue,
  );
};
