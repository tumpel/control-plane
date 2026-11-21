import { TenantEventSchema } from "@tumpel/schemas";

export const DELIVERY_BATCH = 100;
export const DELIVERY_PROMPT_LIMIT = 4000;
const SESSION_ID_MAX = 64;

export type DeliveryEvent = { event_id: number; payload: string; created_at: number };

export const eventReference = (eventId: number, event: string, sessionId: string): string =>
  JSON.stringify({
    eventId,
    event,
    sessionId,
    tooLongToInline: `read it in full with GET /v1/events?afterEventId=${eventId - 1}&event=${event}&sessionId=${sessionId} (tumpel_events_wait); it is the first event of the page`,
  });

export const widestReference = (events: string[]): string =>
  eventReference(
    Number.MAX_SAFE_INTEGER,
    events.reduce((widest, event) => (event.length > widest.length ? event : widest), ""),
    "x".repeat(SESSION_ID_MAX),
  );

export const subscriptionPrompt = (plan: string, goal: string): string =>
  `${plan}\n\nSubscription goal: ${goal}\nCall tumpel_subscription_complete when the goal holds. End this event turn after dispatching or handling the event; crew work continues in later event turns.`;

export const deliveryPrompt = (
  plan: string,
  tenantId: string,
  events: DeliveryEvent[],
): { prompt: string; lastEventId: number } | null => {
  const parsed = events.map((row) =>
    TenantEventSchema.parse({ ...JSON.parse(row.payload), eventId: row.event_id, tenantId, createdAt: row.created_at }),
  );
  const lines = parsed.map((event) => JSON.stringify(event));
  const batch = parsed
    .map((event, index) => ({
      prompt: `${plan}\n\n${lines.slice(0, index + 1).join("\n")}`,
      lastEventId: event.eventId,
    }))
    .findLast((candidate) => candidate.prompt.length <= DELIVERY_PROMPT_LIMIT);
  if (batch !== undefined) return batch;
  const [first] = parsed;
  if (first === undefined) return null;
  if (!("sessionId" in first)) throw new Error(`delivered event ${first.eventId} (${first.event}) names no session`);
  const prompt = `${plan}\n\n${eventReference(first.eventId, first.event, first.sessionId)}`;
  if (prompt.length > DELIVERY_PROMPT_LIMIT) {
    throw new Error(`event ${first.eventId} does not fit even by reference after a plan the create check admitted`);
  }
  return { prompt, lastEventId: first.eventId };
};
