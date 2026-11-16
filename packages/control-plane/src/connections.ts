import {
  CircleCIConnectionLinkSchema,
  CircleCIConnectionStartSchema,
  ConnectedConnectionSchema,
  type ConnectionSummarySchema,
  ExpiredConnectionSchema,
  ExpiringConnectionSchema,
  GitHubActionsConnectionLinkSchema,
  GitHubActionsConnectionStartSchema,
  NamespaceConnectionLinkSchema,
  NamespaceConnectionStartSchema,
  NotConfiguredConnectionSchema,
  NotConnectedConnectionSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { CIRCLECI_CONFIG_EXAMPLE, CIRCLECI_ORB, circleCIIssuer, readMe } from "./circleci.ts";
import { credentialStanding } from "./circleci-oauth.ts";
import { deleteCircleCIWebhooks } from "./circleci-projects.ts";
import { callerWorkflowExample, DEFAULT_CALLER_WORKFLOW, REUSABLE_WORKFLOW } from "./github-actions.ts";
import { installationsOf, storedApp } from "./github-store.ts";
import { json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { issuerSubject } from "./issuer.ts";
import { ownerRequired } from "./members";
import { apiOriginOf } from "./settings";
import type { BuildProvider, CircleCIRow, NamespaceRow } from "./tenant-prebuilds";

export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const CONNECTIONS_PATH = "/v1/connections";
const PATHS: Record<BuildProvider, string> = {
  GitHubActions: "/v1/github-actions-connection",
  CircleCI: "/v1/circleci-connection",
  Namespace: "/v1/namespace-connection",
};
const OPERATIONS: Record<BuildProvider, string> = {
  GitHubActions: "gitHubActionsConnections",
  CircleCI: "circleCIConnections",
  Namespace: "namespaceConnections",
};
const BUILD_PROVIDERS: readonly BuildProvider[] = ["GitHubActions", "CircleCI", "Namespace"];
const NAMESPACE_AUDIENCE = "federation.namespaceapis.com";

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

const circleCISummary = (row: CircleCIRow | null, now: number): ConnectionSummary => {
  if (row === null) return summary("CircleCI", null, true);
  const standing = credentialStanding(row.credential, now);
  const account = row.accountLabel;
  if (standing.state === "Expiring") {
    return ExpiringConnectionSchema.parse({ kind: "CircleCI", account, ...standing });
  }
  if (standing.state === "Expired") {
    return ExpiredConnectionSchema.parse({ kind: "CircleCI", account, ...standing });
  }
  return summary("CircleCI", account, true);
};

export const listConnections = async (env: Env, caller: Caller): Promise<ConnectionSummary[]> => {
  const app = await storedApp(env.DB);
  const installations = app === null ? [] : await installationsOf(env.DB, caller.tenantId);
  const logins = installations.map((installation) => installation.accountLogin).join(", ");
  const tenant = tenantOf(env, caller);
  const accounts = await tenant.connectedAccounts();
  const openRouter = (await tenant.openRouterSecretSets()).join(", ");
  return [
    summary("GitHub", logins === "" ? null : logins, app !== null),
    summary("GitHubActions", accounts.GitHubActions, true),
    circleCISummary(await tenant.circleCIConnection(), Date.now()),
    summary("Namespace", accounts.Namespace, stageIssuer(env.ISSUER_HOSTNAME) !== null),
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

const circleCIConnectionOf = (env: Env, tenantId: string, row: CircleCIRow): unknown => ({
  circleCIConnectionId: row.circleCIConnectionId,
  tenantId,
  accountLabel: row.accountLabel,
  organizationId: row.organizationId,
  issuer: circleCIIssuer(env.CIRCLECI_OIDC_ORIGIN, row.organizationId),
  credential:
    row.credential.kind === "Authorized"
      ? { kind: "Authorized", expiresAt: new Date(row.credential.expiresAt).toISOString() }
      : { kind: "Pasted" },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const circleCILink = (env: Env, tenantId: string, row: CircleCIRow | null): unknown => {
  const link =
    row === null
      ? { state: "NotConnected" }
      : {
          state: "Connected",
          connection: circleCIConnectionOf(env, tenantId, row),
        };
  return CircleCIConnectionLinkSchema.parse({
    tenantId,
    link,
    orb: CIRCLECI_ORB,
    configExample: CIRCLECI_CONFIG_EXAMPLE,
  });
};

const EXAMPLE_DEFAULT_BRANCH = "main";

const readLink = async (env: Env, caller: Caller, provider: BuildProvider): Promise<unknown> => {
  const tenant = tenantOf(env, caller);
  const { tenantId } = caller;
  if (provider === "GitHubActions") {
    const connection = await tenant.gitHubActionsConnection(tenantId);
    return GitHubActionsConnectionLinkSchema.parse({
      tenantId,
      link: connection === null ? { state: "NotConnected" } : { state: "Connected", connection },
      reusableWorkflow: REUSABLE_WORKFLOW,
      callerWorkflowExample: callerWorkflowExample({
        path: connection?.callerWorkflow ?? DEFAULT_CALLER_WORKFLOW,
        apiOrigin: apiOriginOf(env),
        branch: EXAMPLE_DEFAULT_BRANCH,
      }),
    });
  }
  if (provider === "CircleCI") return circleCILink(env, tenantId, await tenant.circleCIConnection());
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
  if (provider === "CircleCI") {
    const body = await parseBody(request, CircleCIConnectionStartSchema, "circleCIConnections.start");
    if (!body.ok) return body.response;
    const me = await readMe((url, init) => fetch(url, init), env.CIRCLECI_API_ORIGIN, body.value.apiToken);
    if (!me.ok) {
      return problem(422, {
        code: "CircleCITokenRefused",
        title: "CircleCI refused the token",
        detail: `${me.detail}; the token was not stored`,
        fix: "Create a personal API token at https://app.circleci.com/settings/user/tokens as a member of the organization, then connect again with tumpel circleci start --token-stdin; CircleCI's API v2 refuses project tokens",
      });
    }
    await tenant.connectCircleCI(body.value, now);
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
  const verb = route.action === "START" ? "start" : "delete";
  const refused = route.action === "GET" ? null : ownerRequired(caller, `${OPERATIONS[route.provider]}.${verb}`);
  if (refused) return refused;
  if (route.action === "START") return connect(request, env, caller, route.provider);
  if (route.action === "DELETE") {
    const tenant = tenantOf(env, caller);
    const token = route.provider === "CircleCI" ? await tenant.circleCIToken() : null;
    if (token !== null) {
      const refused = await deleteCircleCIWebhooks(
        env,
        token,
        (await tenant.circleCIWebhooks()).map((webhook) => webhook.webhookId),
      );
      if (refused !== null) return refused;
    }
    await tenant.deleteBuildConnection(route.provider);
    return noContent();
  }
  return json(await readLink(env, caller, route.provider));
};
