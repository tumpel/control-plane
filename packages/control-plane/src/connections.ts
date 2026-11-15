import {
  ConnectedConnectionSchema,
  GitHubActionsConnectionLinkSchema,
  GitHubActionsConnectionStartSchema,
  NamespaceConnectionLinkSchema,
  NamespaceConnectionStartSchema,
  NotConfiguredConnectionSchema,
  NotConnectedConnectionSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { installationOf, storedApp } from "./github-store.ts";
import { json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { issuerSubject } from "./issuer.ts";
import type { BuildProvider, NamespaceRow } from "./tenant-prebuilds";

export type ConnectionSummary =
  | z.infer<typeof ConnectedConnectionSchema>
  | z.infer<typeof NotConnectedConnectionSchema>
  | z.infer<typeof NotConfiguredConnectionSchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const CONNECTIONS_PATH = "/v1/connections";
const PATHS: Record<BuildProvider, string> = {
  GitHubActions: "/v1/github-actions-connection",
  Namespace: "/v1/namespace-connection",
};
const BUILD_PROVIDERS: readonly BuildProvider[] = ["GitHubActions", "Namespace"];

const stageIssuer = (issuerHostname: string | undefined): string | null =>
  issuerHostname ? `https://${issuerHostname}` : null;

const subjectPattern = (tenantId: string): string => {
  const pattern = issuerSubject(tenantId, "<personaName>");
  if (!pattern.ok) throw new Error(`the subject pattern of tenant ${tenantId} is refused: ${pattern.detail}`);
  return pattern.subject;
};

const tenantOf = (env: Env, caller: Caller) => env.TENANT.getByName(caller.tenantId);

const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

const summary = (kind: string, account: string | null, configured: boolean): ConnectionSummary => {
  if (!configured) return NotConfiguredConnectionSchema.parse({ kind, state: "NotConfigured" });
  if (account === null) return NotConnectedConnectionSchema.parse({ kind, state: "NotConnected" });
  return ConnectedConnectionSchema.parse({ kind, state: "Connected", account });
};

export const listConnections = async (env: Env, caller: Caller): Promise<ConnectionSummary[]> => {
  const app = await storedApp(env.DB);
  const installation = app === null ? null : await installationOf(env.DB, caller.tenantId);
  const accounts = await tenantOf(env, caller).connectedAccounts();
  return [
    summary("GitHub", installation?.accountLogin ?? null, app !== null),
    summary("GitHubActions", accounts.GitHubActions, true),
    summary("Namespace", accounts.Namespace, stageIssuer(env.ISSUER_HOSTNAME) !== null),
  ];
};

const issuerMissing = () => ({
  detail: "the stage has no issuer hostname, so Namespace cannot trust a token of this control plane",
  fix: "Deploy the stage with npm run deploy, which sets ISSUER_HOSTNAME from the issuer_hostname output of the infra",
});

const namespaceLink = (tenantId: string, issuer: string | null, row: NamespaceRow | null): unknown => {
  if (issuer === null) return { state: "NotConfigured", ...issuerMissing() };
  const subject = subjectPattern(tenantId);
  if (row === null) return { state: "NotConnected", issuer, subjectPattern: subject };
  const { namespaceConnectionId, accountLabel, workspaceId, audience, createdAt, updatedAt } = row;
  return {
    state: "Connected",
    connection: {
      namespaceConnectionId,
      tenantId,
      accountLabel,
      workspaceId,
      issuer,
      subjectPattern: subject,
      audience,
      createdAt,
      updatedAt,
    },
  };
};

const readLink = async (env: Env, caller: Caller, provider: BuildProvider): Promise<unknown> => {
  const tenant = tenantOf(env, caller);
  const { tenantId } = caller;
  if (provider === "GitHubActions") {
    const connection = await tenant.gitHubActionsConnection(tenantId);
    return GitHubActionsConnectionLinkSchema.parse({
      tenantId,
      link: connection === null ? { state: "NotConnected" } : { state: "Connected", connection },
    });
  }
  return NamespaceConnectionLinkSchema.parse({
    tenantId,
    link: namespaceLink(tenantId, stageIssuer(env.ISSUER_HOSTNAME), await tenant.namespaceConnection()),
  });
};

const connect = async (request: Request, env: Env, caller: Caller, provider: BuildProvider): Promise<Response> => {
  const tenant = tenantOf(env, caller);
  const now = Date.now();
  if (provider === "GitHubActions") {
    const body = await parseBody(request, GitHubActionsConnectionStartSchema, "gitHubActionsConnections.start");
    if (!body.ok) return body.response;
    await tenant.connectGitHubActions(caller.tenantId, body.value, now);
    return json(await readLink(env, caller, provider));
  }
  const body = await parseBody(request, NamespaceConnectionStartSchema, "namespaceConnections.start");
  if (!body.ok) return body.response;
  if (stageIssuer(env.ISSUER_HOSTNAME) === null) {
    return problem(409, { code: "IssuerMissing", title: "No issuer", ...issuerMissing() });
  }
  await tenant.connectNamespace(body.value, now);
  return json(await readLink(env, caller, provider));
};

const routeOf = (request: Request, pathname: string): { provider: BuildProvider; action: string } | null => {
  for (const provider of BUILD_PROVIDERS) {
    const path = PATHS[provider];
    if (pathname === path && (request.method === "GET" || request.method === "DELETE")) {
      return { provider, action: request.method };
    }
    if (pathname === `${path}/start` && request.method === "POST") return { provider, action: "START" };
  }
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
  if (route.action === "START") return connect(request, env, caller, route.provider);
  if (route.action === "DELETE") {
    await tenantOf(env, caller).deleteBuildConnection(route.provider);
    return noContent();
  }
  return json(await readLink(env, caller, route.provider));
};
