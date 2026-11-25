import {
  ClaudeSetupCodeSubmitSchema,
  ClaudeSetupListQuerySchema,
  ClaudeSetupPathSchema,
  ClaudeSetupStartSchema,
  ClaudeSetupTokenWriteSchema,
} from "@tumpel/schemas";
import { SETUP_CREDENTIALS } from "./claude-setup";
import { pinnedEntry } from "./harness-catalog";
import { listHostRecords } from "./hosts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { degradedOnly, placementRefusals } from "./placement";
import { releaseUnreadable } from "./releases";
import { placeableFix, why } from "./sessions.ts";
import { tenantApi } from "./tenant-api.ts";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const SETUP_PATH = /^\/v1\/claude-setups\/([^/]+)(\/code|\/token)?$/;
const START_AGAIN = "start the Claude setup again";

const setupNotFound = (claudeSetupId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such Claude setup",
    detail: `your tenant has no Claude setup ${claudeSetupId}`,
    fix: "Start a Claude setup for a secret set and use the claudeSetupId it answers",
  });

const notWaiting = (detail: string): Response =>
  problem(409, {
    code: "ClaudeSetupNotWaiting",
    title: "Claude setup not waiting",
    detail,
    fix: `Read the setup again; once it ended, ${START_AGAIN}`,
  });

const boxTokenRefused = (detail: string): Response =>
  problem(
    401,
    {
      code: "ClaudeSetupBoxTokenRefused",
      title: "Setup box token refused",
      detail,
      fix: "Only the box of this Claude setup writes its token, with the tokenCredential its offer carried",
    },
    { "www-authenticate": "Bearer" },
  );

const start = async (request: Request, url: URL, env: Env, caller: Caller): Promise<Response> => {
  const body = await parseBody(request, ClaudeSetupStartSchema, "claudeSetups.start");
  if (!body.ok) return body.response;
  const tenant = tenantApi(env.TENANT, caller.tenantId);
  const harness = body.value.harness ?? "ClaudeCode";
  const { name, provider } = SETUP_CREDENTIALS[harness];
  const entry = pinnedEntry((await tenant.call("listPins", {})).pins, harness);
  if (entry === undefined) {
    return problem(422, {
      code: "HarnessNotInCatalog",
      title: `${name} not in the catalog`,
      detail: `the catalog holds no ${name} version your tenant can run`,
      fix: `Pin a ${harness} version the harness catalog lists, then ${START_AGAIN}`,
    });
  }
  const now = Date.now();
  const hosts = await listHostRecords(env, caller.tenantId);
  const { started } = await tenant.call("startClaudeSetup", {
    tenantId: caller.tenantId,
    input: {
      principalId: caller.principalId,
      secretSetId: body.value.secretSetId,
      harness,
      harnessVersion: entry.harnessVersion,
      hosts,
      endpoint: url.origin,
    },
    now,
  });
  if (started.kind === "Started") return json(started.setup);
  if (started.kind === "NoSecretSet") {
    return problem(404, {
      code: "NotFound",
      title: "No such secret set",
      detail: `your tenant owns no secret set ${body.value.secretSetId}`,
      fix: "List your secret sets and start the setup for one of their ids",
    });
  }
  if (started.kind === "ReleaseUnreadable") return problem(422, releaseUnreadable(started.detail, START_AGAIN));
  if (started.kind === "OtherCredential") {
    return problem(409, {
      code: "Conflict",
      title: `Secret set holds another ${provider} credential`,
      detail: `secret set ${body.value.secretSetId} holds the ${provider} credential ${started.name}, and a set holds one credential per provider`,
      fix: `Remove ${started.name} from the set, or set up ${name} for another set, then ${START_AGAIN}`,
    });
  }
  const refused = placementRefusals(started.hosts);
  if (degradedOnly(refused)) {
    return problem(409, {
      code: "HostDegraded",
      title: "No healthy host",
      detail: `no host of your tenant is healthy: ${refused.map(why).join(", ")}`,
      fix: `Check that tumpel-supervisor runs on a host and reaches the control plane, then ${START_AGAIN}`,
    });
  }
  return problem(409, {
    code: "NoHostOnline",
    title: "No host online",
    detail:
      refused.length === 0
        ? "your tenant has no hosts"
        : `no host of your tenant can run the setup box: ${refused.map(why).join(", ")}`,
    fix: placeableFix(refused, START_AGAIN),
  });
};

const list = async (url: URL, env: Env, caller: Caller): Promise<Response> => {
  const query = ClaudeSetupListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Invalid query",
      detail: `claudeSetups.list refused the query: ${issues(query.error)}`,
      fix: "Name the secretSetId of one of your secret sets",
    });
  }
  const { setups } = await tenantApi(env.TENANT, caller.tenantId).call("listClaudeSetups", {
    tenantId: caller.tenantId,
    secretSetId: query.data.secretSetId,
    now: Date.now(),
  });
  return json(setups);
};

const writeToken = async (request: Request, env: Env, claudeSetupId: string): Promise<Response> => {
  const authorization = request.headers.get("authorization") ?? "";
  const credential = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (credential === "") return boxTokenRefused("the request carries no Authorization: Bearer token");
  const body = await parseBody(request, ClaudeSetupTokenWriteSchema, "claudeSetupBoxes.writeToken");
  if (!body.ok) return body.response;
  const { tenantId, value, expiresAt } = body.value;
  const tenant = await env.DB.prepare("SELECT 1 FROM tenants WHERE tenant_id = ?").bind(tenantId).first();
  if (tenant === null) return boxTokenRefused(`no Claude setup ${claudeSetupId} takes this token`);
  const { stored } = await tenantApi(env.TENANT, tenantId).call("writeClaudeSetupToken", {
    tenantId,
    claudeSetupId,
    credential,
    token: value,
    ...(expiresAt === undefined ? {} : { tokenExpiresAt: expiresAt }),
    now: Date.now(),
  });
  if (stored.kind === "Stored") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (stored.kind === "NotFound" || stored.kind === "Refused") {
    return boxTokenRefused(`no Claude setup ${claudeSetupId} takes this token`);
  }
  if (stored.kind === "NotWaiting") return notWaiting(stored.detail);
  return problem(409, {
    code: "Conflict",
    title: "Token not stored",
    detail: stored.detail,
    fix: START_AGAIN,
  });
};

export const handleClaudeSetups = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const posting = request.method === "POST";
  if (url.pathname === "/v1/claude-setups") {
    if (!posting && request.method !== "GET") return null;
    const caller = await authenticate(request, env);
    if (caller instanceof Response) return caller;
    return posting ? start(request, url, env, caller) : list(url, env, caller);
  }
  const matched = SETUP_PATH.exec(url.pathname);
  if (matched === null) return null;
  const [, rawId, tail] = matched;
  if (tail === undefined ? request.method !== "GET" : !posting) return null;
  const raw = decodeURIComponent(rawId ?? "");
  const path = ClaudeSetupPathSchema.safeParse({ claudeSetupId: raw });
  if (tail === "/token") {
    if (!path.success) return boxTokenRefused(`no Claude setup ${raw} takes this token`);
    return writeToken(request, env, path.data.claudeSetupId);
  }
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (!path.success) return setupNotFound(raw);
  const { claudeSetupId } = path.data;
  const tenant = tenantApi(env.TENANT, caller.tenantId);
  if (tail === undefined) {
    const { setup } = await tenant.call("getClaudeSetup", {
      tenantId: caller.tenantId,
      claudeSetupId,
      now: Date.now(),
    });
    return setup === null ? setupNotFound(claudeSetupId) : json(setup);
  }
  const body = await parseBody(request, ClaudeSetupCodeSubmitSchema, "claudeSetups.submitCode");
  if (!body.ok) return body.response;
  const { coded } = await tenant.call("submitClaudeSetupCode", {
    tenantId: caller.tenantId,
    claudeSetupId,
    code: body.value.code,
    now: Date.now(),
  });
  if (coded.kind === "NotFound") return setupNotFound(claudeSetupId);
  if (coded.kind === "NotWaiting") return notWaiting(coded.detail);
  return json(coded.setup);
};
