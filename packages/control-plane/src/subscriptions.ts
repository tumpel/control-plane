import {
  SubscriptionCreateSchema,
  SubscriptionListQuerySchema,
  SubscriptionPathSchema,
  SubscriptionPauseSchema,
  type SubscriptionPersonaLacksTumpelMcpSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { DELIVERY_PROMPT_LIMIT, subscriptionPrompt, widestReference } from "./delivery-prompt.ts";
import { issues, json, type Problem, type ProblemStatus, parseBody, problem } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { Env } from "./index.ts";
import { tenantApi } from "./tenant-api.ts";
import type { Subscription } from "./tenant-subscriptions.ts";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const SUBSCRIPTION_PATH = /^\/v1\/subscriptions\/([^/]+)(\/pause|\/resume|\/complete)?$/;

const refused = (status: ProblemStatus, body: Problem): Response => problem(status, body);

const notFound = (subscriptionId: string): Response =>
  refused(404, {
    code: "NotFound",
    title: "No such subscription",
    detail: `your tenant has no subscription ${subscriptionId}`,
    fix: "List your subscriptions with tumpel subscription list and use one of their ids",
  });

const sessionNotFound = (sessionId: string): Response =>
  refused(404, {
    code: "NotFound",
    title: "No such session",
    detail: `your tenant has no session ${sessionId}`,
    fix: "List your sessions and use one of their ids",
  });

const ended = (subscription: Subscription): Response =>
  refused(409, {
    code: "SubscriptionEnded",
    title: "Subscription ended",
    detail: `subscription ${subscription.subscriptionId} has ended and changes no more`,
    fix: "Create a new subscription for the session",
  });

const personOnly = (operation: string): Response =>
  refused(403, {
    code: "Forbidden",
    title: "Only a person can do this",
    detail: `${operation} refuses calls from inside a tumpel session; only a person creates or resumes a subscription`,
    fix: "Tell your person what the subscription must do, and let them set it up",
  });

const notOwnSession = (subscription: Subscription): Response =>
  refused(403, {
    code: "Forbidden",
    title: "Not this session's subscription",
    detail: `subscription ${subscription.subscriptionId} belongs to session ${subscription.sessionId}, and a session changes only its own subscriptions`,
    fix: "Ask your person to change it",
  });

const invalid = (title: string, detail: string, fix: string): Response =>
  refused(400, { code: "InvalidRequest", title, detail, fix });

const personaLacksTumpelMcp = (outcome: z.infer<typeof SubscriptionPersonaLacksTumpelMcpSchema>): Response =>
  invalid(
    "Persona lacks tumpelMcp",
    `persona ${outcome.personaName} has no tumpelMcp, so it cannot start the crew that crewTags names`,
    `Set tumpelMcp: true on persona ${outcome.personaName}, or create the subscription without crewTags`,
  );

const create = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  if (caller.origin.kind === "Turn") return personOnly("subscriptions.create");
  const body = await parseBody(request, SubscriptionCreateSchema, "subscriptions.create");
  if (!body.ok) return body.response;
  const subscription = body.value;
  const now = Date.now();
  if (Date.parse(subscription.expiresAt) <= now) {
    return invalid(
      "Expiry in the past",
      `expiresAt ${subscription.expiresAt} has already passed`,
      "Give an expiresAt in the future, such as seven days from now",
    );
  }
  const tenant = tenantApi(env.TENANT, caller.tenantId);
  const leanest = `${subscription.prompt}\n\n${widestReference(subscription.events)}`;
  const length = subscriptionPrompt(leanest, subscription.goal).length;
  if (length > DELIVERY_PROMPT_LIMIT) {
    return invalid(
      "Plan and goal too long",
      `the plan and goal leave no room for an event: each turn needs ${length} characters with one event delivered by reference, and delivery prompts take at most ${DELIVERY_PROMPT_LIMIT}`,
      `Shorten the plan or the goal by ${length - DELIVERY_PROMPT_LIMIT} characters, then create it again`,
    );
  }
  const { created } = await tenant.call("createSubscription", { tenantId: caller.tenantId, subscription, now });
  if (created.kind === "Created") return json(created.subscription);
  if (created.kind === "PersonaLacksTumpelMcp") return personaLacksTumpelMcp(created);
  if (created.kind === "NotFound") return sessionNotFound(subscription.sessionId);
  if (created.kind === "Archived") {
    return refused(409, {
      code: "SessionArchived",
      title: "Session archived",
      detail: `session ${subscription.sessionId} is archived and takes no subscription`,
      fix: "Start a new session and subscribe that one",
    });
  }
  return refused(409, {
    code: "SessionFailed",
    title: "Session failed",
    detail: `session ${subscription.sessionId} failed and takes no subscription`,
    fix: "Start a new session and subscribe that one",
  });
};

const list = async (url: URL, env: Env, caller: Caller): Promise<Response> => {
  const query = SubscriptionListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    return invalid(
      "Invalid query",
      `subscriptions.list refused the query: ${issues(query.error)}`,
      "Filter by sessionId or by state Active, Paused or Ended",
    );
  }
  const { subscriptions } = await tenantApi(env.TENANT, caller.tenantId).call("listSubscriptions", {
    tenantId: caller.tenantId,
    filter: query.data,
  });
  return json(subscriptions);
};

const changed = (
  outcome:
    | { kind: "Changed"; subscription: Subscription }
    | { kind: "NotFound" }
    | { kind: "Ended"; subscription: Subscription },
  subscriptionId: string,
): Response => {
  if (outcome.kind === "NotFound") return notFound(subscriptionId);
  if (outcome.kind === "Ended") return ended(outcome.subscription);
  return json(outcome.subscription);
};

const one = async (
  request: Request,
  env: Env,
  caller: Caller,
  subscriptionId: string,
  action: string | undefined,
): Promise<Response> => {
  const tenantId = caller.tenantId;
  const tenant = tenantApi(env.TENANT, tenantId);
  const now = Date.now();
  if (action === "/resume" && caller.origin.kind === "Turn") return personOnly("subscriptions.resume");
  const { subscription } = await tenant.call("getSubscription", { tenantId, subscriptionId });
  if (subscription === null) return notFound(subscriptionId);
  if (request.method === "GET") return json(subscription);
  if (caller.origin.kind === "Turn" && caller.origin.sessionId !== subscription.sessionId) {
    return notOwnSession(subscription);
  }
  if (request.method === "DELETE") {
    const { deleted } = await tenant.call("deleteSubscription", { tenantId, subscriptionId, now });
    if (!deleted) return notFound(subscriptionId);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  if (action === "/pause") {
    const body = await parseBody(request, SubscriptionPauseSchema, "subscriptions.pause");
    if (!body.ok) return body.response;
    const { paused } = await tenant.call("pauseSubscription", {
      tenantId,
      subscriptionId,
      message: body.value.message,
      now,
    });
    return changed(paused, subscriptionId);
  }
  if (action === "/complete") {
    const { completed } = await tenant.call("completeSubscription", { tenantId, subscriptionId, now });
    return changed(completed, subscriptionId);
  }
  const { resumed } = await tenant.call("resumeSubscription", { tenantId, subscriptionId, now });
  if (resumed.kind === "PersonaLacksTumpelMcp") return personaLacksTumpelMcp(resumed);
  if (resumed.kind !== "CursorExpired") return changed(resumed, subscriptionId);
  return refused(410, {
    code: "SubscriptionCursorExpired",
    title: "Subscription paused too long",
    detail: `subscription ${subscriptionId} last delivered event ${resumed.cursorEventId}, and the event log now starts at ${resumed.oldestEventId}, so the events in between are gone`,
    fix: "Delete the subscription and create a new one",
  });
};

export const handleSubscriptions = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const { pathname } = url;
  const { method } = request;
  const listing = pathname === "/v1/subscriptions" && (method === "GET" || method === "POST");
  const match = SUBSCRIPTION_PATH.exec(pathname);
  const action = match?.[2];
  const routed =
    listing || (match !== null && (action === undefined ? method === "GET" || method === "DELETE" : method === "POST"));
  if (!routed) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (listing) return method === "POST" ? create(request, env, caller) : list(url, env, caller);
  const raw = decodeURIComponent(match?.[1] ?? "");
  const path = SubscriptionPathSchema.safeParse({ subscriptionId: raw });
  if (!path.success) return notFound(raw);
  return one(request, env, caller, path.data.subscriptionId, action);
};
