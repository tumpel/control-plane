import {
  DeviceAuthorizationSchema,
  DeviceCodeRequestSchema,
  DeviceDecisionSchema,
  DeviceTokenRequestSchema,
  DeviceTokenSchema,
  HealthSchema,
  OAuthAuthorizationCodeRequestSchema,
  OAuthClientRegistrationSchema,
  OAuthRefreshTokenRequestSchema,
  PersonaPathSchema,
  PersonaSchema,
  SignUpSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { accessVerifier, cachedAccessKeys, type Verification, type Verify } from "./access";
import { randomToken, sameSecret } from "./crypto";
import {
  approveDeviceCode,
  DEVICE_CODE_LIMITS,
  DEVICE_CODE_TTL_MS,
  DEVICE_GRANT,
  denyDeviceCode,
  formatUserCode,
  GRANT_ERRORS,
  listDevices,
  POLL_INTERVAL_S,
  parseUserCode,
  pendingDeviceCode,
  pollDeviceCode,
  revokeDevice,
  startDeviceCode,
} from "./device";
import { issues, json, oauthError, parseBody, problem, readJson, readParams, seeOther, signedOut } from "./http";
import { bearerOf, type Caller, callerForDeviceToken, signUp, whoamiForEmail, whoamiOf } from "./identity";
import { mcpEndpoint, mcpRefusal, type RunTool } from "./mcp";
import {
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  askRefusal,
  authorizationServerMetadata,
  CONNECTOR_ORIGINS,
  CONSENT_PATH,
  callerForAccessToken,
  clientFor,
  clientName,
  forgetAuthorization,
  grantCode,
  MCP_PATH,
  PROTECTED_RESOURCE_PATH,
  pendingAuthorization,
  protectedResourceMetadata,
  REGISTER_PATH,
  readAuthorizeAsk,
  redeemCode,
  redirectBack,
  redirectFor,
  refreshGrant,
  registerClient,
  resourceMetadataUrl,
  startAuthorization,
  TOKEN_PATH,
  usableRedirect,
} from "./oauth";
import {
  CONSENT_CSRF_COOKIE,
  confirmPage,
  enterCodePage,
  grantPage,
  messagePage,
  readCookie,
  signUpPage,
} from "./pages";
import type { Tenant } from "./tenant";

export { Tenant } from "./tenant";

export interface Env {
  DB: D1Database;
  TENANT: DurableObjectNamespace<Tenant>;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
}

const DEVICE_PAGE = "/device";

let verifier: { key: string; verify: Verify } | undefined;

const verifierFor = (env: Env): Verify => {
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD) {
    throw new Error(
      "ACCESS_ISSUER and ACCESS_AUD are not set; bind the Cloudflare Access team and application audience",
    );
  }
  const key = `${env.ACCESS_ISSUER} ${env.ACCESS_AUD}`;
  if (verifier?.key === key) return verifier.verify;
  const keys = cachedAccessKeys(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`);
  verifier = { key, verify: accessVerifier(keys, env.ACCESS_ISSUER, env.ACCESS_AUD) };
  return verifier.verify;
};

const assertedEmail = async (request: Request, env: Env): Promise<Verification> => {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return { ok: false, reason: "no Cloudflare Access sign-in reached this address" };
  const verified = await verifierFor(env)(assertion);
  return verified.ok
    ? verified
    : { ok: false, reason: `the Cloudflare Access sign-in was rejected: ${verified.reason}` };
};

const browserSignedOut = (url: URL, reason: string): Response =>
  signedOut(reason, `Open ${url.origin}${DEVICE_PAGE} in a browser and sign in through Cloudflare Access`);

const noTenant = (url: URL, email: string): Response =>
  problem(403, {
    code: "Forbidden",
    title: "No tenant",
    detail: `${email} belongs to no tenant`,
    fix: `Create one first at ${url.origin}${DEVICE_PAGE}`,
  });

const sameOriginJson = (request: Request, url: URL): Response | null => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return problem(403, {
      code: "Forbidden",
      title: "Cross-origin request",
      detail: `${url.pathname} answers its own origin and this request came from ${origin}`,
      fix: `Call it from ${url.origin}`,
    });
  }
  return null;
};

const handleSignUp = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const signed = await assertedEmail(request, env);
  if (!signed.ok) return browserSignedOut(url, signed.reason);
  const refused = sameOriginJson(request, url);
  if (refused) return refused;
  const body = await parseBody(request, SignUpSchema, "signUp");
  if (!body.ok) return body.response;
  const now = Date.now();
  const whoami = await signUp(env.DB, signed.email, body.value.name, now);
  await env.TENANT.getByName(whoami.tenant.tenantId).open(whoami.tenant.tenantId, now);
  return json(WhoamiSchema.parse(whoami));
};

const deviceCaller = async (request: Request, env: Env): Promise<Caller | Response> => {
  const caller = await callerForDeviceToken(env.DB, bearerOf(request), Date.now());
  return caller ?? signedOut("this device token is missing, unknown or revoked", "Run tumpel login");
};

const handleWhoami = async (request: Request, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(WhoamiSchema.parse(await whoamiOf(env.DB, caller)));
};

const handleDevicesList = async (request: Request, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await listDevices(env.DB, caller));
};

const handlePersonasList = async (request: Request, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const personas = await env.TENANT.getByName(caller.tenantId).listPersonas(caller.tenantId);
  return json(PersonaSchema.array().parse(personas));
};

const PERSONAS_PATH = "/v1/personas/";

const handlePersonaGet = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const path = PersonaPathSchema.safeParse({
    personaId: decodeURIComponent(url.pathname.slice(PERSONAS_PATH.length)),
  });
  const persona = path.success
    ? await env.TENANT.getByName(caller.tenantId).getPersona(caller.tenantId, path.data.personaId)
    : null;
  if (persona === null) {
    return problem(404, {
      code: "NotFound",
      title: "No such persona",
      detail: `your tenant owns no persona ${url.pathname.slice(PERSONAS_PATH.length)}`,
      fix: "List the personas with GET /v1/personas and use one of the ids it returns",
    });
  }
  return json(PersonaSchema.parse(persona));
};

const DEVICES_PATH = "/v1/devices/";

const handleDeviceRevoke = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const deviceId = decodeURIComponent(url.pathname.slice(DEVICES_PATH.length));
  if (!(await revokeDevice(env.DB, caller, deviceId))) {
    return problem(404, {
      code: "NotFound",
      title: "No such device",
      detail: `no device ${deviceId} is signed in as you`,
      fix: "Run tumpel devices list and revoke one of the ids it prints",
    });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

const handleDeviceStart = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const parsed = DeviceCodeRequestSchema.safeParse(await readParams(request));
  if (!parsed.success) return oauthError("invalid_request", issues(parsed.error));
  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const started = await startDeviceCode(env.DB, parsed.data.device_name, clientIp, DEVICE_CODE_LIMITS, Date.now());
  if (!started) {
    return oauthError("slow_down", "too many sign-ins are waiting for approval; try again in ten minutes", 429);
  }
  const userCode = formatUserCode(started.userCode);
  return json(
    DeviceAuthorizationSchema.parse({
      device_code: started.deviceCode,
      user_code: userCode,
      verification_uri: `${url.origin}${DEVICE_PAGE}`,
      verification_uri_complete: `${url.origin}${DEVICE_PAGE}?code=${userCode}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: POLL_INTERVAL_S,
    }),
  );
};

type Decision =
  | { ok: true; caller: Caller; userCode: string | null; typed: string }
  | { ok: false; response: Response };

const readDecision = async (request: Request, url: URL, env: Env, operation: string): Promise<Decision> => {
  const signed = await assertedEmail(request, env);
  if (!signed.ok) return { ok: false, response: browserSignedOut(url, signed.reason) };
  const refused = sameOriginJson(request, url);
  if (refused) return { ok: false, response: refused };
  const body = await parseBody(request, DeviceDecisionSchema, operation);
  if (!body.ok) return body;
  const owner = await whoamiForEmail(env.DB, signed.email);
  if (owner === null) return { ok: false, response: noTenant(url, signed.email) };
  return {
    ok: true,
    caller: { tenantId: owner.tenant.tenantId, principalId: owner.principal.principalId },
    userCode: parseUserCode(body.value.userCode),
    typed: body.value.userCode,
  };
};

const codeNotFound = (typed: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "Code not found",
    detail: `the code ${typed} is wrong, expired or already decided`,
    fix: "Run tumpel login again and enter the code it prints",
  });

const handleDeviceApprove = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const decision = await readDecision(request, url, env, "approve");
  if (!decision.ok) return decision.response;
  const { caller, userCode, typed } = decision;
  const device = userCode === null ? null : await approveDeviceCode(env.DB, userCode, caller, Date.now());
  return device === null ? codeNotFound(typed) : json(device);
};

const handleDeviceDeny = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const decision = await readDecision(request, url, env, "deny");
  if (!decision.ok) return decision.response;
  const { userCode, typed } = decision;
  if (userCode === null || !(await denyDeviceCode(env.DB, userCode, Date.now()))) return codeNotFound(typed);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

const handleDeviceToken = async (request: Request, env: Env): Promise<Response> => {
  const params = await readParams(request);
  if (params.grant_type !== DEVICE_GRANT) {
    return oauthError("unsupported_grant_type", `grant_type must be ${DEVICE_GRANT}`);
  }
  const parsed = DeviceTokenRequestSchema.safeParse(params);
  if (!parsed.success) return oauthError("invalid_request", issues(parsed.error));
  const outcome = await pollDeviceCode(env.DB, parsed.data.device_code, Date.now());
  if (!outcome.ok) return oauthError(outcome.error, GRANT_ERRORS[outcome.error]);
  return json(DeviceTokenSchema.parse({ access_token: outcome.accessToken, token_type: "Bearer" }));
};

const handleDevicePage = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const signed = await assertedEmail(request, env);
  if (!signed.ok) return messagePage(401, "Sign in again", `${signed.reason}.`);
  const owner = await whoamiForEmail(env.DB, signed.email);
  if (owner === null) return signUpPage(signed.email);
  const typed = url.searchParams.get("code") ?? "";
  if (typed === "") return enterCodePage(signed.email, owner.tenant.name);
  const userCode = parseUserCode(typed);
  const pending = userCode === null ? null : await pendingDeviceCode(env.DB, userCode, Date.now());
  if (pending === null) {
    return messagePage(404, "Code not found", "The code is wrong, expired or already decided. Run tumpel login again.");
  }
  return confirmPage(signed.email, owner.tenant.name, formatUserCode(pending.userCode), pending.deviceName);
};

const corsHeaders = (request: Request): Record<string, string> => {
  const origin = request.headers.get("origin");
  if (origin === null || !CONNECTOR_ORIGINS.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name",
    "access-control-expose-headers": "www-authenticate",
    "access-control-max-age": "86400",
    vary: "origin",
  };
};

const withHeaders = (answer: Response, extra: Record<string, string>): Response => {
  if (Object.keys(extra).length === 0) return answer;
  const headers = new Headers(answer.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(answer.body, { status: answer.status, headers });
};

const preflight = (request: Request): Response =>
  new Response(null, { status: 204, headers: { ...corsHeaders(request), "cache-control": "no-store" } });

const mcpCaller = async (request: Request, env: Env): Promise<Caller | Response> => {
  const own = new URL(request.url).origin;
  const metadata = resourceMetadataUrl(own);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== own && !CONNECTOR_ORIGINS.includes(origin)) {
    return mcpRefusal(403, {
      code: "Forbidden",
      title: "Origin refused",
      detail: `${MCP_PATH} answers ${[own, ...CONNECTOR_ORIGINS].join(", ")} and this request declared the origin ${origin}`,
      fix: "Call it from one of those origins; a client that is not a browser sends no Origin header",
    });
  }
  const token = bearerOf(request);
  if (token === "") {
    return mcpRefusal(
      401,
      {
        code: "SignedOut",
        title: "Not signed in",
        detail: `no bearer token reached ${MCP_PATH}`,
        fix: "Add tumpel as a custom connector, which registers itself and takes you through the sign-in",
      },
      { "www-authenticate": `Bearer resource_metadata="${metadata}"`, ...corsHeaders(request) },
    );
  }
  const caller = await callerForAccessToken(env.DB, token, Date.now());
  if (caller === null) {
    return mcpRefusal(
      401,
      {
        code: "SignedOut",
        title: "Not signed in",
        detail: "this access token is unknown, expired or revoked",
        fix: "Connect the connector again",
      },
      { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}"`, ...corsHeaders(request) },
    );
  }
  return caller;
};

const runTool =
  (env: Env, caller: Caller): RunTool =>
  async () => ({ ok: true, text: JSON.stringify(await whoamiOf(env.DB, caller)) });

const handleMcp = async (request: Request, env: Env): Promise<Response> => {
  if (request.method === "OPTIONS") return preflight(request);
  const answered = await mcpEndpoint(request, async () => {
    const caller = await mcpCaller(request, env);
    return caller instanceof Response ? caller : runTool(env, caller);
  });
  return withHeaders(answered, corsHeaders(request));
};

const handleRegister = async (request: Request, env: Env): Promise<Response> => {
  const parsed = OAuthClientRegistrationSchema.safeParse(await readJson(request));
  if (!parsed.success) return oauthError("invalid_client_metadata", issues(parsed.error));
  if (!parsed.data.redirect_uris.every(usableRedirect)) {
    return oauthError(
      "invalid_redirect_uri",
      "every redirect_uri must be an https address carrying no fragment and no userinfo",
    );
  }
  const client = await registerClient(
    env.DB,
    clientName(parsed.data.client_name),
    parsed.data.redirect_uris,
    Date.now(),
  );
  return json(client, 201);
};

const handleAuthorize = async (url: URL, env: Env): Promise<Response> => {
  const ask = readAuthorizeAsk(url);
  const client = ask.clientId === "" ? null : await clientFor(env.DB, ask.clientId);
  if (client === null) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Unknown client",
      detail: "the client asking for access has not registered with this tumpel",
      fix: "Remove the connector and add it again",
    });
  }
  const redirectUri = redirectFor(ask, client);
  if (redirectUri === null) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Wrong callback",
      detail: "the address the client asked to be sent back to is not one it registered",
      fix: "Remove the connector and add it again",
    });
  }
  const refused = askRefusal(ask, url.origin);
  if (refused !== null) {
    return seeOther(
      redirectBack(redirectUri, ask.state, url.origin, {
        error: refused.error,
        error_description: refused.description,
      }),
    );
  }
  const requestId = await startAuthorization(env.DB, ask, redirectUri, Date.now());
  return seeOther(`${url.origin}${CONSENT_PATH}?request=${requestId}`);
};

const handleConsent = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const signed = await assertedEmail(request, env);
  if (!signed.ok) return messagePage(401, "Sign in again", `${signed.reason}.`);
  const owner = await whoamiForEmail(env.DB, signed.email);
  if (owner === null) {
    return messagePage(
      403,
      "No tenant",
      `${signed.email} belongs to no tenant. Create one at ${url.origin}${DEVICE_PAGE}.`,
    );
  }
  const expired = (): Response =>
    messagePage(
      404,
      "Nothing to connect",
      "This sign-in has expired or was already finished. Start again from the client.",
    );
  if (request.method === "GET") {
    const asked = await pendingAuthorization(env.DB, url.searchParams.get("request") ?? "", Date.now());
    if (asked === null) return expired();
    return grantPage(signed.email, asked.clientName, new URL(asked.redirectUri).origin, asked.requestId, randomToken());
  }
  const form = new URLSearchParams(await request.text());
  const cookie = readCookie(request.headers.get("cookie"), CONSENT_CSRF_COOKIE);
  const csrf = form.get("csrf") ?? "";
  if (request.headers.get("origin") !== url.origin || cookie === null || !sameSecret(cookie, csrf)) {
    return messagePage(403, "Request refused", "The form did not come from this page. Reload it and try again.");
  }
  const asked = await pendingAuthorization(env.DB, form.get("request") ?? "", Date.now());
  if (asked === null) return expired();
  const action = form.get("action");
  if (action === "deny") {
    await forgetAuthorization(env.DB, asked.requestId);
    return seeOther(
      redirectBack(asked.redirectUri, asked.state, url.origin, {
        error: "access_denied",
        error_description: "the sign-in was cancelled",
      }),
    );
  }
  if (action !== "approve") return messagePage(400, "Bad request", "Choose Connect or Cancel.");
  const code = await grantCode(env.DB, asked, owner.principal.principalId, Date.now());
  return seeOther(redirectBack(asked.redirectUri, asked.state, url.origin, { code }));
};

const GRANT_SCHEMAS = {
  authorization_code: OAuthAuthorizationCodeRequestSchema,
  refresh_token: OAuthRefreshTokenRequestSchema,
} as const;

const isGrantType = (value: unknown): value is keyof typeof GRANT_SCHEMAS =>
  typeof value === "string" && Object.hasOwn(GRANT_SCHEMAS, value);

const resourcesOf = (resource: string | undefined): string[] =>
  resource === undefined || resource === "" ? [] : [resource];

const handleToken = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const params = await readParams(request);
  if (params.grant_type === undefined) return oauthError("invalid_request", "grant_type is missing");
  if (!isGrantType(params.grant_type)) {
    return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }
  if (params.grant_type === "refresh_token") {
    const parsed = OAuthRefreshTokenRequestSchema.safeParse(params);
    if (!parsed.success) return oauthError("invalid_request", issues(parsed.error));
    const { refresh_token, client_id, resource } = parsed.data;
    const outcome = await refreshGrant(env.DB, refresh_token, client_id, url.origin, resourcesOf(resource), Date.now());
    return outcome.ok ? json(outcome.token) : oauthError(outcome.error, outcome.description);
  }
  const parsed = OAuthAuthorizationCodeRequestSchema.safeParse(params);
  if (!parsed.success) return oauthError("invalid_request", issues(parsed.error));
  const { code, code_verifier, client_id, redirect_uri, resource } = parsed.data;
  const outcome = await redeemCode(
    env.DB,
    {
      code,
      codeVerifier: code_verifier,
      clientId: client_id,
      redirectUri: redirect_uri,
      resources: resourcesOf(resource),
    },
    url.origin,
    Date.now(),
  );
  return outcome.ok ? json(outcome.token) : oauthError(outcome.error, outcome.description);
};

const wellKnown = (pathname: string): ((origin: string) => unknown) | null => {
  for (const [path, document] of [
    [PROTECTED_RESOURCE_PATH, protectedResourceMetadata],
    [AUTHORIZATION_SERVER_PATH, authorizationServerMetadata],
  ] as const) {
    if (pathname === path || pathname === `${path}${MCP_PATH}`) return document;
  }
  return null;
};

type Route = (request: Request, url: URL, env: Env) => Promise<Response>;

const ROUTES: Record<string, Route> = {
  "POST /v1/tenants": handleSignUp,
  "GET /v1/whoami": (request, _url, env) => handleWhoami(request, env),
  "POST /v1/device/code": handleDeviceStart,
  "POST /v1/device/approve": handleDeviceApprove,
  "POST /v1/device/deny": handleDeviceDeny,
  "GET /v1/devices": (request, _url, env) => handleDevicesList(request, env),
  "GET /v1/personas": (request, _url, env) => handlePersonasList(request, env),
  "POST /v1/device/token": (request, _url, env) => handleDeviceToken(request, env),
  [`GET ${DEVICE_PAGE}`]: handleDevicePage,
  [`OPTIONS ${MCP_PATH}`]: (request, _url, env) => handleMcp(request, env),
  [`POST ${MCP_PATH}`]: (request, _url, env) => handleMcp(request, env),
  [`GET ${MCP_PATH}`]: (request, _url, env) => handleMcp(request, env),
  [`OPTIONS ${REGISTER_PATH}`]: async (request) => preflight(request),
  [`POST ${REGISTER_PATH}`]: async (request, _url, env) =>
    withHeaders(await handleRegister(request, env), corsHeaders(request)),
  [`GET ${AUTHORIZE_PATH}`]: (_request, url, env) => handleAuthorize(url, env),
  [`GET ${CONSENT_PATH}`]: handleConsent,
  [`POST ${CONSENT_PATH}`]: handleConsent,
  [`OPTIONS ${TOKEN_PATH}`]: async (request) => preflight(request),
  [`POST ${TOKEN_PATH}`]: async (request, url, env) =>
    withHeaders(await handleToken(request, url, env), corsHeaders(request)),
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json(HealthSchema.parse({ status: "Ok" }));
    const document = wellKnown(url.pathname);
    if (request.method === "GET" && document !== null) {
      return json(document(url.origin), 200, {
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
      });
    }
    const route = ROUTES[`${request.method} ${url.pathname}`];
    if (route) return route(request, url, env);
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith(DEVICES_PATH) &&
      url.pathname.length > DEVICES_PATH.length
    ) {
      return handleDeviceRevoke(request, url, env);
    }
    if (
      request.method === "GET" &&
      url.pathname.startsWith(PERSONAS_PATH) &&
      url.pathname.length > PERSONAS_PATH.length
    ) {
      return handlePersonaGet(request, url, env);
    }
    return problem(404, {
      code: "NotFound",
      title: "No such route",
      detail: `No route for ${request.method} ${url.pathname}`,
      fix: "Call /healthz or an operation of the tumpel contract in packages/api",
    });
  },
} satisfies ExportedHandler<Env>;
