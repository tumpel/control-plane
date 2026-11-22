import {
  ConnectedConnectionSchema,
  type ConnectionSummarySchema,
  NotConfiguredConnectionSchema,
  NotConnectedConnectionSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { installationsOf, storedApp } from "./github-store.ts";
import { json } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { tenantApi } from "./tenant-api.ts";

export type ConnectionSummary = z.infer<typeof ConnectionSummarySchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const CONNECTIONS_PATH = "/v1/connections";

const summary = (kind: string, account: string | null, configured: boolean): ConnectionSummary => {
  if (!configured) return NotConfiguredConnectionSchema.parse({ kind, state: "NotConfigured" });
  if (account === null) return NotConnectedConnectionSchema.parse({ kind, state: "NotConnected" });
  return ConnectedConnectionSchema.parse({ kind, state: "Connected", account });
};

export const listConnections = async (env: Env, caller: Caller): Promise<ConnectionSummary[]> => {
  const app = await storedApp(env.DB);
  const installations = app === null ? [] : await installationsOf(env.DB, caller.tenantId);
  const logins = installations.map((installation) => installation.accountLogin).join(", ");
  const openRouter = (await tenantApi(env.TENANT, caller.tenantId).call("openRouterSecretSets", {})).names.join(", ");
  return [
    summary("GitHub", logins === "" ? null : logins, app !== null),
    summary("OpenRouter", openRouter === "" ? null : openRouter, true),
  ];
};

export const handleConnections = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  if (url.pathname !== CONNECTIONS_PATH || request.method !== "GET") return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  return json(await listConnections(env, caller));
};
