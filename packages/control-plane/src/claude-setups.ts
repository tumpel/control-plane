import {
  ClaudeSetupCodeSubmitSchema,
  ClaudeSetupPathSchema,
  ClaudeSetupStartSchema,
  ClaudeSetupTokenWriteSchema,
} from "@tumpel/api/schemas";
import { pinnedEntry } from "./harness-catalog";
import { listHosts } from "./hosts";
import { json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { placeableFix, why } from "./sessions";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const SETUP_PATH = /^\/v1\/claude-setups\/([^/]+)(\/code|\/token)?$/;
const START_AGAIN = "start the Claude setup again";

const setupNotFound = (claudeSetupId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such Claude setup",
    detail: `your tenant has no Claude setup ${claudeSetupId}`,
    fix: "Start one with tumpel claude-setup start <secretSetId> and use the claudeSetupId it answers",
  });

const notWaiting = (detail: string): Response =>
  problem(409, {
    code: "ClaudeSetupNotWaiting",
    title: "Claude setup not waiting",
    detail,
    fix: `Read the setup with tumpel claude-setup get; once it ended, ${START_AGAIN}`,
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
  const tenant = env.TENANT.getByName(caller.tenantId);
  const entry = pinnedEntry(await tenant.listPins(), "ClaudeCode");
  if (entry === undefined) {
    return problem(422, {
      code: "HarnessNotInCatalog",
      title: "Claude Code not in the catalog",
      detail: "the catalog holds no Claude Code version your tenant can run",
      fix: `Pin a version tumpel harness list shows for ClaudeCode with tumpel harness pin, then ${START_AGAIN}`,
    });
  }
  const now = Date.now();
  const hosts = await listHosts(env.DB, caller.tenantId);
  const started = await tenant.startClaudeSetup(
    caller.tenantId,
    {
      principalId: caller.principalId,
      secretSetId: body.value.secretSetId,
      harnessVersion: entry.harnessVersion,
      hosts,
      endpoint: url.origin,
    },
    now,
  );
  if (started.kind === "Started") return json(started.setup);
  if (started.kind === "NoSecretSet") {
    return problem(404, {
      code: "NotFound",
      title: "No such secret set",
      detail: `your tenant owns no secret set ${body.value.secretSetId}`,
      fix: "List the secret sets with tumpel secret-set list and start the setup for one of their ids",
    });
  }
  if (started.kind === "OtherCredential") {
    return problem(409, {
      code: "Conflict",
      title: "Secret set holds another Anthropic credential",
      detail: `secret set ${body.value.secretSetId} holds the Anthropic credential ${started.name}, and a set holds one credential per provider`,
      fix: `Remove ${started.name} from the set with tumpel config apply, or set up Claude Code for another set, then ${START_AGAIN}`,
    });
  }
  return problem(409, {
    code: "NoHostOnline",
    title: "No host online",
    detail:
      started.hosts.length === 0
        ? "your tenant has no hosts"
        : `no host of your tenant can run the setup box: ${started.hosts.map(why).join(", ")}`,
    fix: placeableFix(started.hosts, START_AGAIN),
  });
};

const writeToken = async (request: Request, env: Env, claudeSetupId: string): Promise<Response> => {
  const authorization = request.headers.get("authorization") ?? "";
  const credential = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (credential === "") return boxTokenRefused("the request carries no Authorization: Bearer token");
  const body = await parseBody(request, ClaudeSetupTokenWriteSchema, "claudeSetupBoxes.writeToken");
  if (!body.ok) return body.response;
  const { tenantId, value } = body.value;
  const tenant = await env.DB.prepare("SELECT 1 FROM tenants WHERE tenant_id = ?").bind(tenantId).first();
  if (tenant === null) return boxTokenRefused(`no Claude setup ${claudeSetupId} takes this token`);
  const stored = await env.TENANT.getByName(tenantId).writeClaudeSetupToken(
    tenantId,
    claudeSetupId,
    credential,
    value,
    Date.now(),
  );
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
    if (!posting) return null;
    const caller = await authenticate(request, env);
    if (caller instanceof Response) return caller;
    return start(request, url, env, caller);
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
  const tenant = env.TENANT.getByName(caller.tenantId);
  if (tail === undefined) {
    const setup = await tenant.getClaudeSetup(caller.tenantId, claudeSetupId, Date.now());
    return setup === null ? setupNotFound(claudeSetupId) : json(setup);
  }
  const body = await parseBody(request, ClaudeSetupCodeSubmitSchema, "claudeSetups.submitCode");
  if (!body.ok) return body.response;
  const coded = await tenant.submitClaudeSetupCode(caller.tenantId, claudeSetupId, body.value.code, Date.now());
  if (coded.kind === "NotFound") return setupNotFound(claudeSetupId);
  if (coded.kind === "NotWaiting") return notWaiting(coded.detail);
  return json(coded.setup);
};
