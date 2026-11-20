import { WebhookEndpointCreateSchema, WebhookEndpointPathSchema, WebhookSigningKeySchema } from "@tumpel/schemas";
import { json, noContent, parseBody, problem } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { Env } from "./index.ts";
import { keyStoreOf } from "./key-store.ts";
import { ownerRequired } from "./members.ts";
import { tenantApi } from "./tenant-api.ts";
import { webhookSenderName } from "./webhook-sender.ts";
import { webhookPublicKey } from "./webhook-signing.ts";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const ENDPOINTS_PATH = "/v1/webhook-endpoints";
const ENDPOINT_PATH = /^\/v1\/webhook-endpoints\/([^/]+)$/;
const SIGNING_KEY_PATH = "/v1/webhook-signing-key";

const writeRefused = (caller: Caller, operation: string): Response | null => {
  if (caller.origin.kind === "Turn") {
    return problem(403, {
      code: "Forbidden",
      title: "Only a person can do this",
      detail: `${operation} refuses calls from inside a tumpel session; only a person installs or deletes a webhook endpoint`,
      fix: "Ask an Owner of the tenant to do it",
    });
  }
  return ownerRequired(caller, operation);
};

const notFound = (webhookEndpointId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such webhook endpoint",
    detail: `your tenant has no webhook endpoint ${webhookEndpointId}`,
    fix: "List your webhook endpoints and use one of their ids",
  });

export const handleWebhooks = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const endpointMatch = ENDPOINT_PATH.exec(url.pathname);
  const routed =
    (url.pathname === ENDPOINTS_PATH && (request.method === "GET" || request.method === "POST")) ||
    (endpointMatch !== null && (request.method === "GET" || request.method === "DELETE")) ||
    (url.pathname === SIGNING_KEY_PATH && request.method === "GET");
  if (!routed) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  const tenant = tenantApi(env.TENANT, caller.tenantId);
  if (url.pathname === SIGNING_KEY_PATH) {
    return json(
      WebhookSigningKeySchema.parse({
        algorithm: "Ed25519",
        publicKey: await webhookPublicKey(keyStoreOf(env), caller.tenantId),
      }),
    );
  }
  if (url.pathname === ENDPOINTS_PATH && request.method === "GET") {
    return json((await tenant.call("listWebhookEndpoints", { tenantId: caller.tenantId })).endpoints);
  }
  if (url.pathname === ENDPOINTS_PATH) {
    const refused = writeRefused(caller, "webhookEndpoints.create");
    if (refused !== null) return refused;
    const body = await parseBody(request, WebhookEndpointCreateSchema, "webhookEndpoints.create");
    if (!body.ok) return body.response;
    const { endpoint } = await tenant.call("createWebhookEndpoint", {
      tenantId: caller.tenantId,
      endpoint: body.value,
      now: Date.now(),
    });
    return json(endpoint);
  }
  const raw = endpointMatch?.[1] ?? "";
  const path = WebhookEndpointPathSchema.safeParse({ webhookEndpointId: decodeURIComponent(raw) });
  if (!path.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Invalid webhook endpoint id",
      detail: "webhookEndpoints refused a webhookEndpointId that does not match the operation's schema",
      fix: "Use the webhookEndpointId that webhook endpoint list returns",
    });
  }
  const { webhookEndpointId } = path.data;
  if (request.method === "GET") {
    const { endpoint } = await tenant.call("getWebhookEndpoint", { tenantId: caller.tenantId, webhookEndpointId });
    return endpoint === null ? notFound(webhookEndpointId) : json(endpoint);
  }
  const refused = writeRefused(caller, "webhookEndpoints.delete");
  if (refused !== null) return refused;
  const { deleted } = await tenant.call("deleteWebhookEndpoint", { tenantId: caller.tenantId, webhookEndpointId });
  if (!deleted) return notFound(webhookEndpointId);
  await env.WEBHOOKS.getByName(webhookSenderName(caller.tenantId, webhookEndpointId)).stop();
  return noContent();
};
