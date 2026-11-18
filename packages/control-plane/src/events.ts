import { type EventPageSchema, EventQuerySchema } from "@tumpel/schemas";
import type { z } from "zod";
import { channelUrl, type Subscription } from "./event-channel.ts";
import type { Authenticate } from "./github-handlers.ts";
import { issues, json, problem } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { Env } from "./index.ts";
import { tenantApi } from "./tenant-api.ts";

export const EVENTS_PATH = "/v1/events";

type EventQuery = z.infer<typeof EventQuerySchema>;
type EventPage = z.infer<typeof EventPageSchema>;
type Read = { kind: "Read"; page: EventPage } | { kind: "Expired"; response: Response };

const read = async (env: Env, caller: Caller, query: EventQuery, afterEventId: number | null): Promise<Read> => {
  const { listed } = await tenantApi(env.TENANT, caller.tenantId).call("listEvents", {
    tenantId: caller.tenantId,
    afterEventId,
    events: query.event ?? [],
    sessionId: query.sessionId ?? null,
    waitSeconds: 0,
  });
  if (listed.kind === "Read") return { kind: "Read", page: listed.page };
  return {
    kind: "Expired",
    response: problem(410, {
      code: "EventCursorExpired",
      title: "Event cursor expired",
      detail: `event ${afterEventId} is older than the oldest event kept, ${listed.oldestEventId}; the log keeps 7 days`,
      fix: "Read the current state of what you follow, then read events again without afterEventId",
    }),
  };
};

const subscriptionOf = (caller: Caller, query: EventQuery, cursor: number): Subscription => ({
  tenantId: caller.tenantId,
  cursor,
  events: query.event ?? [],
  sessionId: query.sessionId ?? null,
});

const openChannel = (env: Env, subscription: Subscription): Promise<Response> =>
  env.EVENTS.getByName(subscription.tenantId).fetch(channelUrl(subscription), { headers: { upgrade: "websocket" } });

const firstEvent = async (env: Env, subscription: Subscription, waitSeconds: number): Promise<void> => {
  const { webSocket } = await openChannel(env, subscription);
  if (webSocket === null) throw new Error(`the event channel of tenant ${subscription.tenantId} answered no WebSocket`);
  webSocket.accept();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitSeconds * 1000);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    webSocket.addEventListener("message", done);
    webSocket.addEventListener("close", done);
  });
  webSocket.close(1000, "the long poll ended");
};

export const listEvents = async (env: Env, caller: Caller, query: EventQuery): Promise<Response> => {
  const first = await read(env, caller, query, query.afterEventId ?? null);
  if (first.kind === "Expired") return first.response;
  if (first.page.events.length > 0 || query.waitSeconds === 0) return json(first.page);
  await firstEvent(env, subscriptionOf(caller, query, first.page.lastEventId), query.waitSeconds);
  const next = await read(env, caller, query, first.page.lastEventId);
  return next.kind === "Read" ? json(next.page) : next.response;
};

const followEvents = async (env: Env, caller: Caller, query: EventQuery): Promise<Response> => {
  const start = await read(env, caller, query, query.afterEventId ?? null);
  if (start.kind === "Expired") return start.response;
  return openChannel(env, subscriptionOf(caller, query, query.afterEventId ?? start.page.lastEventId));
};

export const handleEvents = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  if (url.pathname !== EVENTS_PATH || request.method !== "GET") return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  const number = (name: string): number | string | undefined => {
    const value = url.searchParams.get(name);
    return value === null ? undefined : /^\d+$/.test(value) ? Number(value) : value;
  };
  const events = url.searchParams.getAll("event");
  const query = EventQuerySchema.safeParse({
    afterEventId: number("afterEventId"),
    event: events.length > 0 ? events : undefined,
    sessionId: url.searchParams.get("sessionId") ?? undefined,
    waitSeconds: number("waitSeconds"),
  });
  if (!query.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Invalid query",
      detail: `events.list refused the query: ${issues(query.error)}`,
      fix: "Send query parameters that match the operation's schema in typespec",
    });
  }
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return followEvents(env, caller, query.data);
  return listEvents(env, caller, query.data);
};
