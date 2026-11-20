import type { TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";

type TenantEvent = z.infer<typeof TenantEventSchema>;

export type PushNotification = { title: string; body: string; path: string };

const tenantPath = (tenantId: string): string => `/t/${encodeURIComponent(tenantId)}`;

const sessionPath = (event: { tenantId: string; sessionId: string }): string =>
  `${tenantPath(event.tenantId)}/sessions/${encodeURIComponent(event.sessionId)}`;

const turnPath = (event: { tenantId: string; sessionId: string; turnId: string }): string =>
  `${sessionPath(event)}/turns/${encodeURIComponent(event.turnId)}`;

export const pushSessionName = (repository: string): string => {
  const name = new URL(repository).pathname.split("/").filter(Boolean).at(-1) ?? repository;
  return name.endsWith(".git") ? name.slice(0, -4) : name;
};

const paused = (event: Extract<TenantEvent, { event: "SubscriptionPaused" }>, session: string): PushNotification => {
  const body =
    event.reason.kind === "ByRequest"
      ? event.reason.message
      : event.reason.kind === "DeliveryFailed"
        ? "A delivery turn failed. Open the session to decide what to do next."
        : "Several crew turns failed. Open the session to decide what to do next.";
  return { title: `Subscription paused in ${session}`, body, path: sessionPath(event) };
};

const ended = (event: Extract<TenantEvent, { event: "SubscriptionEnded" }>, session: string): PushNotification => {
  const body = {
    SessionArchived: "The session was archived.",
    SessionFailed: "The session failed.",
    Expired: "The subscription expired.",
    GoalMet: "The subscription reached its goal.",
  }[event.reason];
  return { title: `Subscription ended in ${session}`, body, path: sessionPath(event) };
};

export const pushNotification = (event: TenantEvent, sessionName: string | null): PushNotification => {
  const session = sessionName ?? ("sessionId" in event ? event.sessionId : "the session");
  switch (event.event) {
    case "TurnStarted":
      return { title: `Turn started in ${session}`, body: "The turn is running.", path: turnPath(event) };
    case "TurnCompleted":
      return {
        title: `Turn completed in ${session}`,
        body: "Open the session to read the result.",
        path: turnPath(event),
      };
    case "TurnFailed":
      return { title: `Turn failed in ${session}`, body: event.detail, path: turnPath(event) };
    case "SessionIdle":
      return { title: `${session} is idle`, body: "The session is ready for another turn.", path: sessionPath(event) };
    case "SessionStopped":
      return { title: `${session} stopped`, body: "The session stopped.", path: sessionPath(event) };
    case "SessionFailed":
      return { title: `${session} failed`, body: "Open the session to see what happened.", path: sessionPath(event) };
    case "SessionArchived":
      return { title: `${session} was archived`, body: "The session is archived.", path: sessionPath(event) };
    case "SubscriptionPaused":
      return paused(event, session);
    case "SubscriptionEnded":
      return ended(event, session);
    case "HostOnline":
      return {
        title: "Host online",
        body: `Host ${event.hostId} is online.`,
        path: `${tenantPath(event.tenantId)}/hosts/${encodeURIComponent(event.hostId)}`,
      };
    case "HostOffline":
      return {
        title: "Host offline",
        body: `Host ${event.hostId} is offline.`,
        path: `${tenantPath(event.tenantId)}/hosts/${encodeURIComponent(event.hostId)}`,
      };
    case "PrebuildDone":
      return {
        title: `Prebuild ready for ${pushSessionName(event.repository)}`,
        body: "The prebuild finished.",
        path: `${tenantPath(event.tenantId)}/prebuilds`,
      };
    case "PrebuildFailed":
      return {
        title: `Prebuild failed for ${pushSessionName(event.repository)}`,
        body: `The ${event.phase.toLowerCase()} phase failed.`,
        path: `${tenantPath(event.tenantId)}/prebuilds`,
      };
    case "TriggerStartRefused":
      return {
        title: "Trigger did not start a session",
        body: event.refusal.detail,
        path: `${tenantPath(event.tenantId)}/triggers/${encodeURIComponent(event.triggerId)}`,
      };
  }
};
