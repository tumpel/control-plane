import type { TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";

type TenantEvent = z.infer<typeof TenantEventSchema>;
type ForemanEvent = Extract<TenantEvent, { event: "SubscriptionPaused" | "SubscriptionEnded" }>;

export type PushNotification = { title: string; body: string; path: string };

export const pushSessionName = (repository: string): string => {
  const name = new URL(repository).pathname.split("/").filter(Boolean).at(-1) ?? repository;
  return name.endsWith(".git") ? name.slice(0, -4) : name;
};

export const pushNotification = (event: ForemanEvent, session: string): PushNotification => {
  const path = `/t/${encodeURIComponent(event.tenantId)}/sessions/${encodeURIComponent(event.sessionId)}`;
  if (event.event === "SubscriptionPaused") {
    const body =
      event.reason.kind === "ByRequest"
        ? event.reason.message
        : event.reason.kind === "DeliveryFailed"
          ? "A delivery turn failed. Open the session to decide what to do next."
          : "Several crew turns failed. Open the session to decide what to do next.";
    return { title: `Subscription paused in ${session}`, body, path };
  }
  const body = {
    SessionArchived: "The session was archived.",
    SessionFailed: "The session failed.",
    Expired: "The subscription expired.",
    GoalMet: "The subscription reached its goal.",
  }[event.reason];
  return { title: `Subscription ended in ${session}`, body, path };
};
