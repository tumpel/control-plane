import { PushNotificationSchema, type TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";

type TenantEvent = z.infer<typeof TenantEventSchema>;
type ForemanEvent = Extract<TenantEvent, { event: "SubscriptionPaused" | "SubscriptionEnded" }>;

export const pushNotification = (event: ForemanEvent, session: string): z.infer<typeof PushNotificationSchema> => {
  const path = `/t/${encodeURIComponent(event.tenantId)}/sessions/${encodeURIComponent(event.sessionId)}`;
  if (event.event === "SubscriptionPaused") {
    const body =
      event.reason.kind === "ByRequest"
        ? event.reason.message
        : event.reason.kind === "DeliveryFailed"
          ? "A delivery turn failed. Open the session to decide what to do next."
          : "Several crew turns failed. Open the session to decide what to do next.";
    return PushNotificationSchema.parse({ title: `Subscription paused in ${session}`, body, path });
  }
  const body = {
    SessionArchived: "The session was archived.",
    SessionFailed: "The session failed.",
    Expired: "The subscription expired.",
    GoalMet: "The subscription reached its goal.",
  }[event.reason];
  return PushNotificationSchema.parse({ title: `Subscription ended in ${session}`, body, path });
};
