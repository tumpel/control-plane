import { type EventPageSchema, EventQuerySchema } from "@tumpel/schemas";
import type { z } from "zod";
import { channelUrl, eventCursorExpired, type Subscription } from "./event-channel.ts";
import type { Authenticate } from "./github-handlers.ts";
import { issues, json, problem } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { Env } from "./index.ts";
import { tenantApi } from "./tenant-api.ts";

export const EVENTS_PATH = "/v1/events";
const BEARER_SUBPROTOCOL = "tumpel.bearer";

type EventQuery = z.infer<typeof EventQuerySchema>;
type EventPage = z.infer<typeof EventPageSchema>;
type Read = { kind: "Read"; page: EventPage } | { kind: "Expired"; response: Response };

const read = async (env: Env, caller: Caller, query: EventQuery, afterEventId: number | null): Promise<Read> => {
  const { listed } = await tenantApi(env.TENANT, caller.tenantId).call("listEvents", {
    tenantId: caller.tenantId,
    afterEventId,
    events: query.event ?? [],
    sessionId: query.sessionId ?? null,
    triggerId: query.triggerId ?? null,
  });
  if (listed.kind === "Read") return { kind: "Read", page: listed.page };
  return {
    kind: "Expired",
    response: eventCursorExpired(afterEventId ?? 0, listed.oldestEventId),
  };
};

const subscriptionOf = (caller: Caller, query: EventQuery, cursor: number): Subscription => ({
  tenantId: caller.tenantId,
  cursor,
  events: query.event ?? [],
  sessionId: query.sessionId ?? null,
  triggerId: query.triggerId ?? null,
});

const openChannel = (env: Env, subscription: Subscription): Promise<Response> =>
  env.EVENTS.getByName(subscription.tenantId).fetch(channelUrl(subscription), { headers: { upgrade: "websocket" } });

export const waitOnChannel = async (
  env: Env,
  subscription: Subscription,
  waitSeconds: number,
  wanted: (event: Record<string, unknown>) => boolean,
): Promise<void> => {
  const { webSocket } = await openChannel(env, subscription);
  if (webSocket === null) throw new Error(`the event channel of tenant ${subscription.tenantId} answered no WebSocket`);
  webSocket.accept();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitSeconds * 1000);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    webSocket.addEventListener("message", (message) => {
      if (wanted(JSON.parse(String(message.data)) as Record<string, unknown>)) done();
    });
    webSocket.addEventListener("close", done);
  });
  webSocket.close(1000, "the long poll ended");
};

export const listEvents = async (env: Env, caller: Caller, query: EventQuery): Promise<Response> => {
  const first = await read(env, caller, query, query.afterEventId ?? null);
  if (first.kind === "Expired") return first.response;
  return json(first.page);
};

const followEvents = async (env: Env, caller: Caller, query: EventQuery): Promise<Response> => {
  if (query.afterEventId !== undefined) return openChannel(env, subscriptionOf(caller, query, query.afterEventId));
  const start = await read(env, caller, query, query.afterEventId ?? null);
  if (start.kind === "Expired") return start.response;
  return openChannel(env, subscriptionOf(caller, query, start.page.lastEventId));
};

const subprotocolBearer = (request: Request): string | null => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((name) => name.trim());
  const prefix = `${BEARER_SUBPROTOCOL}.`;
  return offered.find((name) => name.startsWith(prefix))?.slice(prefix.length) ?? null;
};

const withBearer = (request: Request, token: string): Request => {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request, { headers });
};

const echoSubprotocol = (answer: Response): Response =>
  answer.webSocket === null
    ? answer
    : new Response(null, {
        status: answer.status,
        headers: { "sec-websocket-protocol": BEARER_SUBPROTOCOL },
        webSocket: answer.webSocket,
      });

export const handleEvents = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  if (url.pathname !== EVENTS_PATH || request.method !== "GET") return null;
  const token = subprotocolBearer(request);
  const caller = await authenticate(token === null ? request : withBearer(request, token), env);
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
    triggerId: url.searchParams.get("triggerId") ?? undefined,
  });
  if (!query.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Invalid query",
      detail: `events.list refused the query: ${issues(query.error)}`,
      fix: "Send query parameters that match the operation's schema in typespec",
    });
  }
  if (token !== null) return echoSubprotocol(await followEvents(env, caller, query.data));
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return followEvents(env, caller, query.data);
  return listEvents(env, caller, query.data);
};
