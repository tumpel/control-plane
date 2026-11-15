import {
  CiDispatchConnectionLinkSchema,
  CiDispatchConnectionStartSchema,
  ConnectedConnectionSchema,
  EphemeralVmConnectionLinkSchema,
  EphemeralVmConnectionStartSchema,
  NotConfiguredConnectionSchema,
  NotConnectedConnectionSchema,
  RemoteBuildKitConnectionLinkSchema,
  RemoteBuildKitConnectionStartSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { BUILD_PROVIDER_ORDER, type BuildProviderKind, stageIssuer, subjectPattern } from "./build-provider.ts";
import { installationOf, storedApp } from "./github-store.ts";
import { json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import type { RemoteBuildKitRow } from "./tenant-prebuilds";

export type ConnectionSummary =
  | z.infer<typeof ConnectedConnectionSchema>
  | z.infer<typeof NotConnectedConnectionSchema>
  | z.infer<typeof NotConfiguredConnectionSchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const CONNECTIONS_PATH = "/v1/connections";
const PATHS: Record<BuildProviderKind, string> = {
  CiDispatch: "/v1/ci-dispatch-connection",
  RemoteBuildKit: "/v1/remote-buildkit-connection",
  EphemeralVm: "/v1/ephemeral-vm-connection",
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
    ...BUILD_PROVIDER_ORDER.map((kind) =>
      summary(kind, accounts[kind], kind !== "RemoteBuildKit" || stageIssuer(env.ISSUER_HOSTNAME) !== null),
    ),
  ];
};

const issuerMissing = () => ({
  detail: "the stage has no issuer hostname, so no provider can trust a token of this control plane",
  fix: "Deploy the stage with npm run deploy, which sets ISSUER_HOSTNAME from the issuer_hostname output of the infra",
});

const remoteBuildKitLink = (tenantId: string, issuer: string | null, row: RemoteBuildKitRow | null): unknown => {
  if (issuer === null) return { state: "NotConfigured", ...issuerMissing() };
  const subject = subjectPattern(tenantId);
  if (row === null) return { state: "NotConnected", issuer, subjectPattern: subject };
  const { remoteBuildKitConnectionId, accountLabel, audience, createdAt, updatedAt } = row;
  return {
    state: "Connected",
    connection: {
      remoteBuildKitConnectionId,
      tenantId,
      accountLabel,
      issuer,
      subjectPattern: subject,
      audience,
      createdAt,
      updatedAt,
    },
  };
};

const connected = (connection: unknown): unknown =>
  connection === null ? { state: "NotConnected" } : { state: "Connected", connection };

const readLink = async (env: Env, caller: Caller, kind: BuildProviderKind): Promise<unknown> => {
  const tenant = tenantOf(env, caller);
  const { tenantId } = caller;
  if (kind === "CiDispatch") {
    return CiDispatchConnectionLinkSchema.parse({
      tenantId,
      link: connected(await tenant.ciDispatchConnection(tenantId)),
    });
  }
  if (kind === "EphemeralVm") {
    return EphemeralVmConnectionLinkSchema.parse({
      tenantId,
      link: connected(await tenant.ephemeralVmConnection(tenantId)),
    });
  }
  return RemoteBuildKitConnectionLinkSchema.parse({
    tenantId,
    link: remoteBuildKitLink(tenantId, stageIssuer(env.ISSUER_HOSTNAME), await tenant.remoteBuildKitConnection()),
  });
};

const connect = async (request: Request, env: Env, caller: Caller, kind: BuildProviderKind): Promise<Response> => {
  const tenant = tenantOf(env, caller);
  const now = Date.now();
  if (kind === "CiDispatch") {
    const body = await parseBody(request, CiDispatchConnectionStartSchema, "ciDispatchConnections.start");
    if (!body.ok) return body.response;
    await tenant.connectCiDispatch(caller.tenantId, body.value, now);
  }
  if (kind === "EphemeralVm") {
    const body = await parseBody(request, EphemeralVmConnectionStartSchema, "ephemeralVmConnections.start");
    if (!body.ok) return body.response;
    await tenant.connectEphemeralVm(caller.tenantId, body.value, now);
  }
  if (kind === "RemoteBuildKit") {
    const body = await parseBody(request, RemoteBuildKitConnectionStartSchema, "remoteBuildKitConnections.start");
    if (!body.ok) return body.response;
    if (stageIssuer(env.ISSUER_HOSTNAME) === null) {
      return problem(409, { code: "IssuerMissing", title: "No issuer", ...issuerMissing() });
    }
    await tenant.connectRemoteBuildKit(body.value, now);
  }
  return json(await readLink(env, caller, kind));
};

const routeOf = (request: Request, pathname: string): { kind: BuildProviderKind; action: string } | null => {
  for (const kind of BUILD_PROVIDER_ORDER) {
    const path = PATHS[kind];
    if (pathname === path && (request.method === "GET" || request.method === "DELETE")) {
      return { kind, action: request.method };
    }
    if (pathname === `${path}/start` && request.method === "POST") return { kind, action: "START" };
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
  if (route.action === "START") return connect(request, env, caller, route.kind);
  if (route.action === "DELETE") {
    await tenantOf(env, caller).deleteBuildConnection(route.kind);
    return noContent();
  }
  return json(await readLink(env, caller, route.kind));
};
