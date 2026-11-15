import { OpenRouterAuthorizationStartSchema } from "@tumpel/api/schemas";
import { openRouterNotConnectedPage } from "@tumpel/pages";
import { dashboardReturn } from "./github.ts";
import { json, parseBody, problem, seeOther } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { ownerRequired } from "./members";
import { parseCallback, readState, returnTo, STATE_PURPOSE, stateOfPath } from "./openrouter-oauth.ts";
import { dashboardOrigin, htmlPage } from "./pages";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const AUTHORIZE_PATH = "/v1/openrouter-connection/authorize";
const AUTHORIZATION_PATH = /^\/v1\/openrouter-connection\/authorizations\/([^/]+)$/;

const secretSetPage = (env: Env, tenantId: string, secretSetId: string): string =>
  `${dashboardOrigin(env)}/t/${encodeURIComponent(tenantId)}/secrets/${encodeURIComponent(secretSetId)}`;

const authorize = async (request: Request, url: URL, env: Env, caller: Caller): Promise<Response> => {
  const refused = ownerRequired(caller, "openRouterConnections.authorize");
  if (refused) return refused;
  const body = await parseBody(request, OpenRouterAuthorizationStartSchema, "openRouterConnections.authorize");
  if (!body.ok) return body.response;
  const { secretSetId, returnUrl } = body.value;
  const back = dashboardReturn(returnUrl ?? null, env.DASHBOARD_ORIGIN);
  if (!back.ok) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Return URL refused",
      detail: `openRouterConnections.authorize refused the return URL: ${back.detail}`,
      fix: `Leave returnUrl out, or name a page on ${env.DASHBOARD_ORIGIN || "the dashboard"}`,
    });
  }
  const started = await env.TENANT.getByName(caller.tenantId).startOpenRouterAuthorization(
    caller.tenantId,
    caller.principalId,
    {
      secretSetId,
      returnUrl: back.returnUrl ?? secretSetPage(env, caller.tenantId, secretSetId),
      controlPlaneOrigin: url.origin,
    },
    Date.now(),
  );
  if (started.kind === "Started") return json(started.authorization);
  if (started.kind === "NoSecretSet") {
    return problem(404, {
      code: "NotFound",
      title: "No such secret set",
      detail: `your tenant holds no secret set ${secretSetId}`,
      fix: "List the secret sets with tumpel secret-set list and pass a secretSetId it prints",
    });
  }
  return problem(409, {
    code: "Conflict",
    title: "Secret set holds another OpenRouter credential",
    detail: `secret set ${secretSetId} holds the OpenRouter credential ${started.name}, and a set holds one credential per provider`,
    fix: `Remove ${started.name} with tumpel secret-set remove-member, then connect OpenRouter again`,
  });
};

const readAuthorization = async (env: Env, caller: Caller, openRouterAuthorizationId: string): Promise<Response> => {
  const read = await env.TENANT.getByName(caller.tenantId).getOpenRouterAuthorization(
    caller.tenantId,
    caller.principalId,
    openRouterAuthorizationId,
    Date.now(),
  );
  if (read.kind === "Found") return json(read.authorization);
  return problem(404, {
    code: "NotFound",
    title: "No such OpenRouter authorization",
    detail: `you started no OpenRouter authorization ${openRouterAuthorizationId} in this tenant`,
    fix: "Start one with tumpel openrouter authorize or Connect OpenRouter on a secret set's page",
  });
};

export const handleOpenRouterAuthorizations = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const authorizing = request.method === "POST" && url.pathname === AUTHORIZE_PATH;
  const reading = request.method === "GET" ? AUTHORIZATION_PATH.exec(url.pathname)?.[1] : undefined;
  if (!authorizing && reading === undefined) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (reading !== undefined) return readAuthorization(env, caller, decodeURIComponent(reading));
  return authorize(request, url, env, caller);
};

export const handleOpenRouterCallback = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  if (request.method !== "GET") return null;
  const state = stateOfPath(url.pathname);
  if (state === null) return null;
  const refuse = (detail: string) =>
    htmlPage(env, new URL(url.origin), 400, (links) => openRouterNotConnectedPage(links, detail));
  const checked = await readState(await keyStoreOf(env).signingKey(STATE_PURPOSE), state);
  if (!checked.ok) return refuse(`${checked.reason}, so no authorization of this control plane started it`);
  const callback = parseCallback(url.searchParams);
  if (callback.kind === "Invalid") return refuse(callback.detail);
  const { tenantId, openRouterAuthorizationId } = checked.claims;
  const settled = await env.TENANT.getByName(tenantId).openRouterCallback(
    tenantId,
    openRouterAuthorizationId,
    callback,
    Date.now(),
  );
  if (settled.kind === "NotFound") {
    return refuse(`tenant ${tenantId} holds no OpenRouter authorization ${openRouterAuthorizationId}`);
  }
  return seeOther(returnTo(settled.returnUrl, openRouterAuthorizationId));
};
