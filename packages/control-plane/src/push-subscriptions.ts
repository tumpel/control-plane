import { PushKeySchema, PushSubscriptionCreateSchema, PushSubscriptionPathSchema } from "@tumpel/schemas";
import type { Authenticate } from "./github-handlers.ts";
import { json, noContent, parseBody, problem } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { Env } from "./index.ts";
import { tenantApi } from "./tenant-api.ts";

const PUSH_SUBSCRIPTIONS_PATH = "/v1/push-subscriptions";
const PUSH_SUBSCRIPTION_PATH = /^\/v1\/push-subscriptions\/([^/]+)$/;
const PUSH_KEY_PATH = "/v1/push-key";

const notFound = (pushSubscriptionId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such notification subscription",
    detail: `you have no notification subscription ${pushSubscriptionId}`,
    fix: "List your notification subscriptions and use one of their ids",
  });

const personRequired = (caller: Caller, operation: string): Response | null =>
  caller.origin.kind === "Person"
    ? null
    : problem(403, {
        code: "Forbidden",
        title: "Only a person can do this",
        detail: `${operation} refuses calls from inside a tumpel session`,
        fix: "Open the Tumpel dashboard and change notifications there",
      });

const pushKey = (env: Env): Response => {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error(
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set in the Worker configuration before notifications are used",
    );
  }
  return json(PushKeySchema.parse({ applicationServerKey: env.VAPID_PUBLIC_KEY }));
};

const list = async (env: Env, caller: Caller): Promise<Response> => {
  const { subscriptions } = await tenantApi(env.TENANT, caller.tenantId).call("listPushSubscriptions", {
    tenantId: caller.tenantId,
    principalId: caller.principalId,
  });
  return json(subscriptions);
};

const create = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  const body = await parseBody(request, PushSubscriptionCreateSchema, "pushSubscriptions.create");
  if (!body.ok) return body.response;
  const { subscription } = await tenantApi(env.TENANT, caller.tenantId).call("createPushSubscription", {
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    subscription: body.value,
    now: Date.now(),
  });
  return json(subscription);
};

const remove = async (env: Env, caller: Caller, raw: string): Promise<Response> => {
  const path = PushSubscriptionPathSchema.safeParse({ pushSubscriptionId: decodeURIComponent(raw) });
  if (!path.success) return notFound(raw);
  const { pushSubscriptionId } = path.data;
  const { deleted } = await tenantApi(env.TENANT, caller.tenantId).call("deletePushSubscription", {
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    pushSubscriptionId,
  });
  return deleted ? noContent() : notFound(pushSubscriptionId);
};

export const handlePushSubscriptions = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const listing = url.pathname === PUSH_SUBSCRIPTIONS_PATH && (request.method === "GET" || request.method === "POST");
  const matched = request.method === "DELETE" ? PUSH_SUBSCRIPTION_PATH.exec(url.pathname)?.[1] : undefined;
  const key = url.pathname === PUSH_KEY_PATH && request.method === "GET";
  if (!listing && matched === undefined && !key) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (key) return pushKey(env);
  if (request.method !== "GET") {
    const refused = personRequired(caller, `pushSubscriptions.${request.method === "POST" ? "create" : "delete"}`);
    if (refused !== null) return refused;
  }
  if (matched !== undefined) return remove(env, caller, matched);
  return request.method === "POST" ? create(request, env, caller) : list(env, caller);
};
