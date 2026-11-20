import { TenantEventSchema } from "@tumpel/schemas";

export const DELIVERY_BATCH = 100;
export const EVENT_ROOM = 500;

export type DeliveryEvent = { event_id: number; payload: string; created_at: number };

export const deliveryPrompt = (
  plan: string,
  goal: string,
  tenantId: string,
  events: DeliveryEvent[],
  fold: (prompt: string, goal: string) => string,
  limit: number,
): { prompt: string; lastEventId: number } | null => {
  const lines = events.map((row) =>
    JSON.stringify(
      TenantEventSchema.parse({
        ...JSON.parse(row.payload),
        eventId: row.event_id,
        tenantId,
        createdAt: row.created_at,
      }),
    ),
  );
  for (let count = lines.length; count > 0; count--) {
    const prompt = `${plan}\n\n${lines.slice(0, count).join("\n")}`;
    const last = events[count - 1];
    if (last === undefined) return null;
    if (count === 1 || fold(prompt, goal).length <= limit) return { prompt, lastEventId: last.event_id };
  }
  return null;
};
