import { StartRefusalCodeSchema, TenantEventSchema } from "@tumpel/schemas";
import { z } from "zod";
import { storedEvent } from "./bounded-detail.ts";

export const DELIVERY_BATCH = 100;
export const DELIVERY_PROMPT_LIMIT = 4000;
const SESSION_ID_MAX = 64;

export type DeliveryEvent = { event_id: number; payload: string; created_at: number };

type TenantEvent = z.infer<typeof TenantEventSchema>;
type StartRefusalCode = z.infer<typeof StartRefusalCodeSchema>;
type EventReference = { sessionId: string } | { code: StartRefusalCode } | Record<string, never>;

export type DeliveryBatch =
  | { kind: "Batch"; prompt: string; lastEventId: number; wake: boolean }
  | { kind: "Malformed"; cause: string };

const eventReference = (eventId: number, event: string, context: EventReference): string =>
  JSON.stringify({
    eventId,
    event,
    ...context,
    tooLongToInline: `read it in full with GET /v1/events?afterEventId=${eventId - 1}&event=${event}${"sessionId" in context ? `&sessionId=${context.sessionId}` : ""} (tumpel_events_list); it is the first event of the page`,
  });

const longestCode = StartRefusalCodeSchema.options.reduce((longest, code) =>
  code.length > longest.length ? code : longest,
);

export const widestReference = (events: string[]): string =>
  events
    .map((event) =>
      eventReference(
        Number.MAX_SAFE_INTEGER,
        event,
        event === "StartRefused"
          ? { code: longestCode }
          : event === "CapacityAvailable"
            ? {}
            : { sessionId: "x".repeat(SESSION_ID_MAX) },
      ),
    )
    .reduce((widest, reference) => (reference.length > widest.length ? reference : widest), "");

const wakeEvent = (event: TenantEvent): boolean =>
  event.event === "StartRefused" || event.event === "CapacityAvailable";

export const subscriptionPrompt = (plan: string, goal: string): string =>
  `${plan}\n\nSubscription goal: ${goal}\nCall tumpel_subscription_complete when the goal holds. End this event turn after dispatching or handling the event; crew work continues in later event turns.`;

export const deliveryPrompt = (plan: string, tenantId: string, events: DeliveryEvent[]): DeliveryBatch | null => {
  const parsed: TenantEvent[] = [];
  for (const row of events) {
    const event = TenantEventSchema.safeParse({
      ...storedEvent(row.payload),
      eventId: row.event_id,
      tenantId,
      createdAt: row.created_at,
    });
    if (!event.success) {
      return {
        kind: "Malformed",
        cause: `stored event ${row.event_id} does not match the event schema: ${z.prettifyError(event.error)}`,
      };
    }
    parsed.push(event.data);
  }
  const prefix = new Map<number | string, { line: string; wake: boolean }>();
  let batch: DeliveryBatch | null = null;
  for (const event of parsed) {
    const key =
      event.event === "StartRefused"
        ? event.refusal.code
        : event.event === "CapacityAvailable"
          ? event.event
          : event.eventId;
    prefix.delete(key);
    prefix.set(key, { line: JSON.stringify(event), wake: wakeEvent(event) });
    const lines = [...prefix.values()];
    const prompt = `${plan}\n\n${lines.map(({ line }) => line).join("\n")}`;
    if (prompt.length <= DELIVERY_PROMPT_LIMIT) {
      batch = { kind: "Batch", prompt, lastEventId: event.eventId, wake: lines.some(({ wake }) => wake) };
    }
  }
  if (batch !== null) return batch;
  const [first] = parsed;
  if (first === undefined) return null;
  const context: EventReference =
    first.event === "StartRefused"
      ? { code: first.refusal.code }
      : "sessionId" in first
        ? { sessionId: first.sessionId }
        : {};
  const prompt = `${plan}\n\n${eventReference(first.eventId, first.event, context)}`;
  if (prompt.length > DELIVERY_PROMPT_LIMIT) {
    throw new Error(`event ${first.eventId} does not fit even by reference after a plan the create check admitted`);
  }
  return { kind: "Batch", prompt, lastEventId: first.eventId, wake: wakeEvent(first) };
};
