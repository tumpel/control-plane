import { html, NO_HTML, type Page } from "@tumpel/pages";
import {
  ConnectorPathSchema,
  ConnectorTokenPathSchema,
  ConnectorUpdateSchema,
  OAuthConnectorCreateSchema,
  StaticConnectorCreateSchema,
  StaticConnectorTokenWriteSchema,
} from "@tumpel/schemas";
import {
  CALLBACK_PATH,
  refusedAddress,
  STATE_PURPOSE,
  StateClaimsSchema,
  TURN_TOKEN_PURPOSE,
  tenantOfTurnToken,
  turnTokenMatches,
} from "./connector-oauth.ts";
import { sha256Hex } from "./crypto.ts";
import { readSignedState } from "./github.ts";
import { json, type Problem, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { ownerRequired } from "./members";
import { htmlPage } from "./pages";
import { tenantApi } from "./tenant-api.ts";
import type { ConnectorCallback, ConnectorWritten } from "./tenant-connectors.ts";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const CONNECTOR_PATH = /^\/v1\/connectors\/([^/]+)(\/credential)?$/;
const AUTHORIZE_PATH = /^\/v1\/oauth-connectors\/([^/]+)\/authorize$/;
const TOKEN_PATH = /^\/v1\/static-connectors\/([^/]+)\/token$/;
const TURN_TOKEN_PATH = /^\/v1\/turns\/([^/]+)\/connectors\/([^/]+)\/token$/;

const notFound = (connectorId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such connector",
    detail: `your tenant has no connector ${connectorId}`,
    fix: "List your connectors with tumpel connector list and use one of their ids",
  });

const nameTaken = (name: string): Response =>
  problem(409, {
    code: "Conflict",
    title: "Name taken",
    detail: `your tenant already has a connector named ${name}`,
    fix: "Pick another name, or rename the existing connector",
  });

const changed = (connectorId: string): Response =>
  problem(409, {
    code: "ConnectorChanged",
    title: "Connector changed",
    detail: `connector ${connectorId} changed after you read it, so this write changed nothing`,
    fix: "Read the connector again with tumpel connector get and send the write with its updatedAt",
  });

const UPDATED_AT = /^\d{1,15}$/;

const updatedAtOf = (url: URL, operation: string): number | Response => {
  const raw = url.searchParams.get("updatedAt") ?? "";
  if (UPDATED_AT.test(raw)) return Number(raw);
  return problem(400, {
    code: "InvalidRequest",
    title: "Invalid query",
    detail: `${operation} needs the updatedAt query parameter as epoch milliseconds, and got ${raw === "" ? "none" : raw}`,
    fix: "Read the connector and send its updatedAt, such as ?updatedAt=1763481600000",
  });
};

const answered = (written: ConnectorWritten, connectorId: string, name: string): Response => {
  if (written.kind === "Written") return json(written.connector);
  if (written.kind === "NameTaken") return nameTaken(name);
  if (written.kind === "Changed") return changed(connectorId);
  return notFound(connectorId);
};

const turnTokenRefused = (detail: string): Response =>
  problem(
    401,
    {
      code: "ConnectorTurnTokenRefused",
      title: "Connector token refused",
      detail,
      fix: "Only the box of a running turn fetches a connector's token, with the tokenCredential its offer carried",
    },
    { "www-authenticate": "Bearer" },
  );

const create = async (request: Request, env: Env, caller: Caller, auth: "Static" | "OAuth"): Promise<Response> => {
  const operation = auth === "Static" ? "staticConnectors.create" : "oauthConnectors.create";
  const refused = ownerRequired(caller, operation);
  if (refused) return refused;
  const body = await parseBody(
    request,
    auth === "Static" ? StaticConnectorCreateSchema : OAuthConnectorCreateSchema,
    operation,
  );
  if (!body.ok) return body.response;
  const { name, url } = body.value;
  const unsafe = refusedAddress(url);
  if (unsafe !== null) {
    return problem(422, {
      code: "InvalidRequest",
      title: "Connector address refused",
      detail: `${operation} refused the address: ${unsafe}`,
      fix: "Give the public https address of a remote MCP server",
    });
  }
  const { written: created } = await tenantApi(env.TENANT, caller.tenantId).call("createConnector", {
    tenantId: caller.tenantId,
    auth,
    name,
    url,
    now: Date.now(),
  });
  return answered(created, "", name);
};

const pathId = (raw: string): string | null => {
  const parsed = ConnectorPathSchema.safeParse({ connectorId: decodeURIComponent(raw) });
  return parsed.success ? parsed.data.connectorId : null;
};

const connector = async (
  request: Request,
  url: URL,
  env: Env,
  caller: Caller,
  connectorId: string,
  credential: boolean,
): Promise<Response> => {
  const tenant = tenantApi(env.TENANT, caller.tenantId);
  const now = Date.now();
  if (request.method === "GET" && !credential) {
    const { connector: found } = await tenant.call("getConnector", { tenantId: caller.tenantId, connectorId, now });
    return found === null ? notFound(connectorId) : json(found);
  }
  if (request.method === "DELETE" && credential) {
    const refused = ownerRequired(caller, "connectors.clearCredential");
    if (refused) return refused;
    const updatedAt = updatedAtOf(url, "connectors.clearCredential");
    if (updatedAt instanceof Response) return updatedAt;
    const { written: cleared } = await tenant.call("clearConnectorCredential", {
      tenantId: caller.tenantId,
      connectorId,
      updatedAt,
      now,
    });
    return answered(cleared, connectorId, "");
  }
  if (request.method === "PUT" && !credential) {
    const refused = ownerRequired(caller, "connectors.update");
    if (refused) return refused;
    const updatedAt = updatedAtOf(url, "connectors.update");
    if (updatedAt instanceof Response) return updatedAt;
    const body = await parseBody(request, ConnectorUpdateSchema, "connectors.update");
    if (!body.ok) return body.response;
    const { written: renamed } = await tenant.call("renameConnector", {
      tenantId: caller.tenantId,
      connectorId,
      updatedAt,
      name: body.value.name,
      now,
    });
    return answered(renamed, connectorId, body.value.name);
  }
  const refused = ownerRequired(caller, "connectors.delete");
  if (refused) return refused;
  const updatedAt = updatedAtOf(url, "connectors.delete");
  if (updatedAt instanceof Response) return updatedAt;
  const { deleted } = await tenant.call("deleteConnector", { connectorId, updatedAt });
  if (deleted.kind === "NotFound") return notFound(connectorId);
  if (deleted.kind === "Changed") return changed(connectorId);
  if (deleted.kind === "InUse") {
    return problem(409, {
      code: "ConnectorInUse",
      title: "Connector in use",
      detail: `connector ${connectorId} stays while ${deleted.detail}`,
      fix: "Remove it from every persona that lists it and let running turns finish, then delete it again",
    });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

const authorize = async (url: URL, env: Env, caller: Caller, connectorId: string): Promise<Response> => {
  const refused = ownerRequired(caller, "oauthConnectors.authorize");
  if (refused) return refused;
  const updatedAt = updatedAtOf(url, "oauthConnectors.authorize");
  if (updatedAt instanceof Response) return updatedAt;
  const { started } = await tenantApi(env.TENANT, caller.tenantId).call("startConnectorAuthorization", {
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    connectorId,
    updatedAt,
    controlPlaneOrigin: url.origin,
    now: Date.now(),
  });
  if (started.kind === "Started") return json(started.authorization);
  if (started.kind === "NotFound") return notFound(connectorId);
  if (started.kind === "Changed") return changed(connectorId);
  const failure: Problem =
    started.kind === "DiscoveryFailed"
      ? {
          code: "ConnectorDiscoveryFailed",
          title: "Connector discovery failed",
          detail: started.detail,
          fix: "Check that the connector's address is the remote MCP server itself and that it supports OAuth sign-in, then authorize again",
        }
      : {
          code: "ConnectorRegistrationUnsupported",
          title: "Server refused client registration",
          detail: started.detail,
          fix: "This server needs a token: delete the connector, create a static connector for it and set its token with tumpel connector set-token --stdin",
        };
  return problem(422, failure);
};

const setToken = async (
  request: Request,
  url: URL,
  env: Env,
  caller: Caller,
  connectorId: string,
): Promise<Response> => {
  const refused = ownerRequired(caller, "staticConnectors.setToken");
  if (refused) return refused;
  const updatedAt = updatedAtOf(url, "staticConnectors.setToken");
  if (updatedAt instanceof Response) return updatedAt;
  const body = await parseBody(request, StaticConnectorTokenWriteSchema, "staticConnectors.setToken");
  if (!body.ok) return body.response;
  const { written } = await tenantApi(env.TENANT, caller.tenantId).call("setStaticToken", {
    tenantId: caller.tenantId,
    connectorId,
    updatedAt,
    value: body.value.value,
    now: Date.now(),
  });
  return answered(written, connectorId, "");
};

const fetchToken = async (request: Request, env: Env, rawTurn: string, rawConnector: string): Promise<Response> => {
  const path = ConnectorTokenPathSchema.safeParse({
    turnId: decodeURIComponent(rawTurn),
    connectorId: decodeURIComponent(rawConnector),
  });
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const tenantId = tenantOfTurnToken(token);
  if (!path.success || tenantId === null) return turnTokenRefused("the request carries no connector turn token");
  const { turnId, connectorId } = path.data;
  const key = await keyStoreOf(env).signingKey(TURN_TOKEN_PURPOSE);
  if (!(await turnTokenMatches(key, token, turnId, connectorId))) {
    return turnTokenRefused(`the token is not the one turn ${turnId} holds for connector ${connectorId}`);
  }
  const { served } = await tenantApi(env.TENANT, tenantId).call("serveConnectorToken", {
    turnId,
    connectorId,
    now: Date.now(),
  });
  if (served.kind === "Served") return json(served.token);
  if (served.kind === "Refused") return turnTokenRefused(`turn ${turnId} does not use connector ${connectorId}`);
  if (served.kind === "NotRunning") {
    return problem(409, {
      code: "ConnectorTurnNotRunning",
      title: "Turn not running",
      detail: `turn ${turnId} is not running, so it fetches no connector token`,
      fix: "Send a new turn; each turn's box gets its own connector credentials",
    });
  }
  if (served.kind === "NoCredential") {
    return problem(409, {
      code: "ConnectorDisconnected",
      title: "Connector not connected",
      detail: `connector ${served.name} holds no credential`,
      fix: "An Owner connects the connector again, then the next turn uses it",
    });
  }
  return problem(503, {
    code: "ConnectorRefreshFailed",
    title: "Connector token refresh failed",
    detail: served.detail,
    fix: "Call the tool again; when the failure names a reconnect, an Owner authorizes the connector again",
  });
};

const resultPage = (title: string, mark: "Done" | "Error", detail: string, fix: string | null): Page => ({
  title,
  mark,
  email: null,
  body: html`<p>${detail}</p>`,
  fix,
  detail,
  next: [],
  script: null,
});

const callbackOf = (search: URLSearchParams): ConnectorCallback | null => {
  const code = search.get("code");
  if (code !== null && code !== "") return { kind: "Code", code, issuer: search.get("iss") };
  const error = search.get("error");
  return error === null ? null : { kind: "Error", error: error.replace(/[^a-z_]/g, "") };
};

const handleCallback = async (url: URL, env: Env): Promise<Response> => {
  const notConnected = (detail: string) =>
    htmlPage(env, new URL(url.origin), 400, (links) => ({
      ...resultPage("Connector not connected", "Error", detail, "Go back to your chat and ask to connect it again"),
      next: [{ kind: "Link", label: "Open the dashboard", href: links.dashboard, external: false, hidden: false }],
      body: NO_HTML,
    }));
  const state = url.searchParams.get("state") ?? "";
  const checked = await readSignedState(await keyStoreOf(env).signingKey(STATE_PURPOSE), state, StateClaimsSchema);
  if (!checked.ok)
    return notConnected(`${checked.reason}, so no connector authorization of this control plane sent this callback`);
  const callback = callbackOf(url.searchParams);
  if (callback === null) return notConnected("the provider sent the browser back with neither a code nor an error");
  const { claims } = checked;
  const membership = await env.DB.prepare("SELECT role FROM memberships WHERE tenant_id = ? AND principal_id = ?")
    .bind(claims.tenantId, claims.principalId)
    .first<{ role: string }>();
  const { settled } = await tenantApi(env.TENANT, claims.tenantId).call("connectorCallback", {
    claims,
    stateHash: await sha256Hex(state),
    callback,
    initiatorIsOwner: membership?.role === "Owner",
    now: Date.now(),
  });
  if (settled.kind === "NotConnected") return notConnected(settled.detail);
  return htmlPage(env, new URL(url.origin), 200, () =>
    resultPage(
      `${settled.name} connected`,
      "Done",
      `Connector ${settled.name} is connected. New sessions on a persona that lists it can use it.`,
      "Close this tab and go back to your chat",
    ),
  );
};

export const handleConnectors = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const { method } = request;
  const { pathname } = url;
  if (method === "GET" && pathname === CALLBACK_PATH) return handleCallback(url, env);
  const turnToken = method === "POST" ? TURN_TOKEN_PATH.exec(pathname) : null;
  if (turnToken?.[1] !== undefined && turnToken[2] !== undefined)
    return fetchToken(request, env, turnToken[1], turnToken[2]);
  const listing = method === "GET" && pathname === "/v1/connectors";
  const creating = method === "POST" && (pathname === "/v1/static-connectors" || pathname === "/v1/oauth-connectors");
  const one = CONNECTOR_PATH.exec(pathname);
  const oneMethod =
    one !== null && (one[2] === undefined ? ["GET", "PUT", "DELETE"].includes(method) : method === "DELETE");
  const authorizing = method === "POST" ? AUTHORIZE_PATH.exec(pathname)?.[1] : undefined;
  const tokenFor = method === "PUT" ? TOKEN_PATH.exec(pathname)?.[1] : undefined;
  if (!listing && !creating && !oneMethod && authorizing === undefined && tokenFor === undefined) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (listing)
    return json(
      (
        await tenantApi(env.TENANT, caller.tenantId).call("listConnectors", {
          tenantId: caller.tenantId,
          now: Date.now(),
        })
      ).connectors,
    );
  if (creating) return create(request, env, caller, pathname === "/v1/static-connectors" ? "Static" : "OAuth");
  const raw = one?.[1] ?? authorizing ?? tokenFor ?? "";
  const connectorId = pathId(raw);
  if (connectorId === null) return notFound(decodeURIComponent(raw));
  if (authorizing !== undefined) return authorize(url, env, caller, connectorId);
  if (tokenFor !== undefined) return setToken(request, url, env, caller, connectorId);
  return connector(request, url, env, caller, connectorId, one?.[2] !== undefined);
};
