import { StartRefusedEventSchema } from "@tumpel/schemas";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import { durableDb } from "./db/client.ts";
import type { NewTenantEvent } from "./tenant-events.ts";

export const StartRefusalAttemptSchema = StartRefusedEventSchema.pick({
  operation: true,
  personaId: true,
  model: true,
  harnessVersion: true,
  crewTags: true,
});

export const StartRefusalEventSchema = StartRefusedEventSchema.omit({ eventId: true, tenantId: true, createdAt: true });
type RefusalEvent = z.infer<typeof StartRefusalEventSchema>;
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
  });
};
