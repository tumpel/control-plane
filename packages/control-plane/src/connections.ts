import {
  ConnectedConnectionSchema,
  type ConnectionSummarySchema,
  NamespaceConnectionLinkSchema,
  NamespaceConnectionStartSchema,
  NotConfiguredConnectionSchema,
  NotConnectedConnectionSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { installationsOf, storedApp } from "./github-store.ts";
import { json, noContent, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { issuerSubject } from "./issuer.ts";
import { ownerRequired } from "./members";
import { tenantApi } from "./tenant-api.ts";
import type { NamespaceRow } from "./tenant-prebuilds";

export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const CONNECTIONS_PATH = "/v1/connections";
const NAMESPACE_PATH = "/v1/namespace-connection";
const NAMESPACE_OPERATION = "namespaceConnections";
const NAMESPACE_AUDIENCE = "federation.namespaceapis.com";

const stageIssuer = (issuerHostname: string | undefined): string | null =>
  issuerHostname ? `https://${issuerHostname}` : null;

const subjectPattern = (tenantId: string): string => {
  const pattern = issuerSubject(tenantId, "<personaName>");
  if (!pattern.ok) throw new Error(`the subject pattern of tenant ${tenantId} is refused: ${pattern.detail}`);
  return pattern.subject;
};

const tenantOf = (env: Env, caller: Caller) => tenantApi(env.TENANT, caller.tenantId);

const summary = (kind: string, account: string | null, configured: boolean): ConnectionSummary => {
  if (!configured) return NotConfiguredConnectionSchema.parse({ kind, state: "NotConfigured" });
  if (account === null) return NotConnectedConnectionSchema.parse({ kind, state: "NotConnected" });
  return ConnectedConnectionSchema.parse({ kind, state: "Connected", account });
};

export const listConnections = async (env: Env, caller: Caller): Promise<ConnectionSummary[]> => {
  const app = await storedApp(env.DB);
  const installations = app === null ? [] : await installationsOf(env.DB, caller.tenantId);
  const logins = installations.map((installation) => installation.accountLogin).join(", ");
  const namespace = (await tenantOf(env, caller).call("namespaceConnection", {})).connection;
  const openRouter = (await tenantApi(env.TENANT, caller.tenantId).call("openRouterSecretSets", {})).names.join(", ");
  return [
    summary("GitHub", logins === "" ? null : logins, app !== null),
    summary("Namespace", namespace?.accountLabel ?? null, stageIssuer(env.ISSUER_HOSTNAME) !== null),
    summary("OpenRouter", openRouter === "" ? null : openRouter, true),
  ];
};

const issuerMissing = () => ({
  detail: "the stage has no issuer hostname, so Namespace cannot trust a token of this control plane",
  fix: "Deploy the stage with npm run deploy, which sets ISSUER_HOSTNAME from the issuer_hostname output of the infra",
});

const namespaceLink = (tenantId: string, issuer: string | null, row: NamespaceRow | null): unknown => {
  if (issuer === null) return { state: "NotConfigured", ...issuerMissing() };
  const subject = subjectPattern(tenantId);
  if (row === null) return { state: "NotConnected", issuer, subjectPattern: subject, audience: NAMESPACE_AUDIENCE };
  const { namespaceConnectionId, accountLabel, workspaceId, createdAt, updatedAt } = row;
  return {
    state: "Connected",
    connection: {
      namespaceConnectionId,
      tenantId,
      accountLabel,
      workspaceId,
      issuer,
      subjectPattern: subject,
      audience: NAMESPACE_AUDIENCE,
      createdAt,
      updatedAt,
    },
  };
};

const readLink = async (env: Env, caller: Caller): Promise<unknown> => {
  const { tenantId } = caller;
  return NamespaceConnectionLinkSchema.parse({
    tenantId,
    link: namespaceLink(
      tenantId,
      stageIssuer(env.ISSUER_HOSTNAME),
      (await tenantOf(env, caller).call("namespaceConnection", {})).connection,
    ),
  });
};

const connect = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  const body = await parseBody(request, NamespaceConnectionStartSchema, "namespaceConnections.start");
  if (!body.ok) return body.response;
  if (stageIssuer(env.ISSUER_HOSTNAME) === null) {
    return problem(409, { code: "IssuerMissing", title: "No issuer", ...issuerMissing() });
  }
  await tenantOf(env, caller).call("connectNamespace", { start: body.value, now: Date.now() });
  return json(await readLink(env, caller));
};

const routeOf = (request: Request, pathname: string): "GET" | "DELETE" | "START" | null => {
  if (pathname === NAMESPACE_PATH && (request.method === "GET" || request.method === "DELETE")) return request.method;
  if (pathname === `${NAMESPACE_PATH}/start` && request.method === "POST") return "START";
  return null;
};

export const handleConnections = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const listing = url.pathname === CONNECTIONS_PATH && request.method === "GET";
  const route = routeOf(request, url.pathname);
  if (!listing && route === null) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (route === null) return json(await listConnections(env, caller));
  const refused =
    route === "GET" ? null : ownerRequired(caller, `${NAMESPACE_OPERATION}.${route === "START" ? "start" : "delete"}`);
  if (refused) return refused;
  if (route === "START") return connect(request, env, caller);
  if (route === "DELETE") {
    await tenantOf(env, caller).call("deleteBuildConnection", { provider: "Namespace" });
    return noContent();
  }
  return json(await readLink(env, caller));
};
