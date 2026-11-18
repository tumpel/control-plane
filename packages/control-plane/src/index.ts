import {
  alreadyApprovedPage,
  type ConsentClient,
  codeNotFoundPage,
  confirmPage,
  consentPage,
  consentRefusedPage,
  enterCodePage,
  noBuildPage,
  noReleasePage,
  noSuchPage,
  noTenantPage,
  nothingToConnectPage,
  signInAgainPage,
  signUpPage,
  type TenantChoice,
  unknownClientPage,
  unreadableReleasePage,
} from "@tumpel/pages";
import {
  DeviceApprovalSchema,
  DeviceAuthorizationSchema,
  DeviceCodeRequestSchema,
  DeviceDecisionSchema,
  DeviceTokenRequestSchema,
  DeviceTokenSchema,
  EffectiveHarnessVersionSchema,
  EnrolmentTokenMintSchema,
  HarnessCatalogEntrySchema,
  HarnessPathSchema,
  HarnessPinCreateSchema,
  HarnessPinSchema,
  HealthSchema,
  HostEnrolSchema,
  HostLabelsSchema,
  IssuerJwksSchema,
  OAuthAuthorizationCodeRequestSchema,
  OAuthClientRegistrationSchema,
  OAuthRefreshTokenRequestSchema,
  OAuthRevocationRequestSchema,
  OpenIdConfigurationSchema,
  PersonaCreateSchema,
  PersonaFileUploadRequestSchema,
  PersonaFileUploadSchema,
  PersonaPathSchema,
  PersonaSchema,
  PersonaUpdateSchema,
  ReleaseCliPathSchema,
  ReleaseSupervisorPathSchema,
  SecretMemberPathSchema,
  SecretSetCreateSchema,
  SecretSetPathSchema,
  SecretSetSchema,
  SecretSetUpdateSchema,
  SecretValueSchema,
  SignUpSchema,
  TenantConfigApplySchema,
  TenantConfigPlanRequestSchema,
  WhoamiSchema,
  WhoamiWithEndpointSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { accessVerifier, type Verification, type Verify } from "./access";
import { CHANNEL_PATH } from "./channel/protocol.ts";
import { handleCircleCIAuthorizations } from "./circleci-authorizations.ts";
import { handleCircleCIEvents } from "./circleci-events.ts";
import { handleCircleCIProjects } from "./circleci-projects.ts";
import { handleClaudeSetups } from "./claude-setups";
import { applyConfig, planConfig } from "./config-apply.ts";
import { handleConnections } from "./connections.ts";
import { randomToken, sameSecret } from "./crypto";
import { handleReleaseRollout } from "./deploy-drain";
import {
  approveDeviceCode,
  DEVICE_CODE_LIMITS,
  DEVICE_CODE_TTL_MS,
  DEVICE_GRANT,
  denyDeviceCode,
  formatUserCode,
  GRANT_ERRORS,
  listDevices,
  parseUserCode,
  pendingDeviceCode,
  pollDeviceCode,
  revokeDevice,
  startDeviceCode,
} from "./device";
import { REPOSITORY_TOKEN } from "./github.ts";
import { handleGitHubConnection, handleGitHubPage, handleGitHubWebhook } from "./github-handlers.ts";
import { effectiveVersions, HARNESS_CATALOG } from "./harness-catalog";
import type { HostChannel } from "./host-channel";
import {
  enrolHost,
  hostNotFound,
  hostOf,
  listEnrolmentTokens,
  listHosts,
  mintEnrolmentToken,
  type Refused,
  revokeEnrolmentToken,
  revokeHost,
  setHostLabels,
  withSupervisorUpdates,
} from "./hosts";
import {
  issues,
  json,
  oauthError,
  parseBody,
  problem,
  readJson,
  readParams,
  seeOther,
  signedOut,
  storedJson,
} from "./http";
import {
  bearerOf,
  type Caller,
  callerForDeviceToken,
  callerOf,
  listTenants,
  membershipsOfEmail,
  proofCaller,
  signUp,
  type Whoami,
  whoamiOf,
} from "./identity";
import installScript from "./install.sh";
import {
  ISSUER_DOCUMENT_HEADERS,
  issuerOf,
  JWKS_PATH,
  OPENID_CONFIGURATION_PATH,
  openIdConfiguration,
} from "./issuer.ts";
import { type Dispatch, mcpEndpoint, mcpRefusal } from "./mcp";
import { handleMembers } from "./members";
import { handleMetrics } from "./metrics";
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
  listGrants,
  MCP_PATH,
  PROTECTED_RESOURCE_PATH,
  pendingAuthorization,
  protectedResourceMetadata,
  REGISTER_PATH,
  REVOKE_PATH,
  readAuthorizeAsk,
  redeemCode,
  redirectBack,
  redirectFor,
  refreshGrant,
  registerClient,
  requestClient,
  resourceMetadataUrl,
  revokeCallerGrant,
  revokeToken,
  SCOPE,
  startAuthorization,
  TOKEN_PATH,
  usableRedirect,
} from "./oauth";
import { handleOpenRouterAuthorizations, handleOpenRouterCallback } from "./openrouter-authorizations.ts";
import {
  CONSENT_CSRF_COOKIE,
  DEVICE_APPROVE_PATH,
  DEVICE_DENY_PATH,
  DEVICE_PAGE,
  dashboardOrigin,
  htmlPage,
  readCookie,
  SIGN_UP_PATH,
  wantsHtml,
} from "./pages";
import { personaFileKey, UPLOAD_TTL_SECONDS } from "./persona-files";
import { handlePrebuildInputs, handlePrebuildUploads } from "./prebuild-uploads.ts";
import { handlePrebuilds } from "./prebuilds";
import { type SignerEnv, signerOf } from "./presign";
import { noticeRelease } from "./release-notices.ts";
import { readRelease } from "./releases";
import { type UnreadableSecretSet, unreadableSecretSet } from "./secret-members.ts";
import type { SessionTimer } from "./session-timer";
import { handleSessions } from "./sessions";
import { settingsOf } from "./settings";
import type { PersonaWrite, Tenant } from "./tenant";
import type { TenantMetrics } from "./tenant-metrics";
import { noRelease, personaFiles, pinRefusal, repositoryTokenUser } from "./write-checks.ts";

export { HostChannel } from "./host-channel";
export { SessionTimer } from "./session-timer";
export { Tenant } from "./tenant";
export { TenantMetrics } from "./tenant-metrics";

export interface Env extends SignerEnv {
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  RELEASES_BUCKET_NAME: string;
  RELEASES_ACCESS_KEY_ID?: string;
  RELEASES_SECRET_ACCESS_KEY?: string;
  DB: D1Database;
  TENANT: DurableObjectNamespace<Tenant>;
  HOST: DurableObjectNamespace<HostChannel>;
  SESSION_TIMER: DurableObjectNamespace<SessionTimer>;
  TENANT_METRICS: DurableObjectNamespace<TenantMetrics>;
  STORE: R2Bucket;
  RELEASES: R2Bucket;
  TUMPEL_SETTINGS: unknown;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
  ACCESS_PROOF_COMMON_NAME?: string;
  SECRETS_KEK?: string;
  ISSUER_HOSTNAME: string;
  DASHBOARD_ORIGIN: string;
  API_ORIGIN: string;
  DEPLOYED_COMMIT: string;
  GITHUB_API_ORIGIN: string;
  GITHUB_WEB_ORIGIN: string;
  CIRCLECI_API_ORIGIN: string;
  CIRCLECI_OIDC_ORIGIN: string;
  CIRCLECI_APP_ORIGIN: string;
  OPENROUTER_ORIGIN: string;
}

let verifier: { key: string; verify: Verify } | undefined;

const verifierFor = (env: Env): Verify => {
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD) {
    throw new Error(
      "ACCESS_ISSUER and ACCESS_AUD are not set; bind the Cloudflare Access team and application audience",
    );
  }
  const key = `${env.ACCESS_ISSUER} ${env.ACCESS_AUD}`;
  if (verifier?.key === key) return verifier.verify;
  verifier = { key, verify: accessVerifier(env.ACCESS_ISSUER, env.ACCESS_AUD) };
  return verifier.verify;
};

const assertedSigner = async (request: Request, env: Env): Promise<Verification> => {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return { ok: false, reason: "no Cloudflare Access sign-in reached this address" };
  const verified = await verifierFor(env)(assertion);
  return verified.ok
    ? verified
    : { ok: false, reason: `the Cloudflare Access sign-in was rejected: ${verified.reason}` };
};

type PersonVerification = Extract<Verification, { kind: "Person" }> | { ok: false; reason: string };

const assertedEmail = async (request: Request, env: Env): Promise<PersonVerification> => {
  const signed = await assertedSigner(request, env);
  if (!signed.ok || signed.kind === "Person") return signed;
  return {
    ok: false,
    reason:
      "a service token signs in only to approve or deny a device code or an MCP connector; sign in to Access as a person",
  };
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
  const { whoami, created } = await signUp(env.DB, signed.email, body.value.name, now);
  if (created) await env.TENANT.getByName(whoami.tenant.tenantId).open(whoami.tenant.tenantId, now);
  return json(WhoamiSchema.parse(whoami));
};

const connectorCallers = new WeakMap<Request, Caller>();

const deviceCaller = async (request: Request, env: Env): Promise<Caller | Response> => {
  const connector = connectorCallers.get(request);
  if (connector !== undefined) return connector;
  const token = bearerOf(request);
  const now = Date.now();
  const caller = (await callerForDeviceToken(env.DB, token, now)) ?? (await callerForAccessToken(env.DB, token, now));
  return (
    caller ??
    signedOut(
      "this device or access token is missing, unknown, expired or revoked",
      "Run tumpel login, or sign the dashboard in again",
    )
  );
};

const handleWhoami = async (request: Request, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const endpoint = new URL(request.url).origin;
  return json(WhoamiWithEndpointSchema.parse({ ...(await whoamiOf(env.DB, caller)), endpoint }));
};

const handleListTenants = async (request: Request, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await listTenants(env.DB, caller));
};

const handleConfigPlan = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, TenantConfigPlanRequestSchema, "tenantConfigs.plan");
  if (!body.ok) return body.response;
  return planConfig(body.value, env, caller);
};

const handleConfigApply = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, TenantConfigApplySchema, "tenantConfigs.apply");
  if (!body.ok) return body.response;
  return applyConfig(body.value, env, caller);
};

const handleGrantsList = async (request: Request, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await listGrants(env.DB, caller, Date.now()));
};

const OAUTH_GRANTS_PATH = "/v1/oauth-grants/";

const handleGrantRevoke = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const grantId = decodeURIComponent(url.pathname.slice(OAUTH_GRANTS_PATH.length));
  if (!(await revokeCallerGrant(env.DB, caller, grantId))) {
    return problem(404, {
      code: "NotFound",
      title: "No such OAuth grant",
      detail: `you hold no OAuth grant ${grantId} in this tenant`,
      fix: "List your OAuth grants and revoke one of their ids",
    });
  }
  return noContent();
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

const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

const personaNotFound = (personaId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such persona",
    detail: `your tenant owns no persona ${personaId}`,
    fix: "List your personas and use one of their ids",
  });

const secretSetNotFound = (secretSetId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such secret set",
    detail: `your tenant owns no secret set ${secretSetId}`,
    fix: "List your secret sets and use one of their ids",
  });

const conflict = (operation: string, name: string, constraint: string): Response => {
  if (constraint.startsWith("secret_values.")) {
    return problem(409, {
      code: "Conflict",
      title: "Repeated member",
      detail: `${operation} names a member of secret set ${name} more than once`,
      fix: "List each member of a secret set once",
    });
  }
  if (constraint.startsWith("secret_credentials.")) {
    return problem(409, {
      code: "Conflict",
      title: "Two credentials for one provider",
      detail: `${operation} gives secret set ${name} more than one API key or subscription token for the same provider`,
      fix: "Keep one credential per provider in a secret set; put the other in a secret set of its own",
    });
  }
  return problem(409, {
    code: "Conflict",
    title: "Name taken",
    detail: `the name ${name} is taken: your tenant already has one by that name`,
    fix: "Pick another name, or update the existing one",
  });
};

const unreadable = (operation: string, read: UnreadableSecretSet): Response =>
  problem(409, unreadableSecretSet(operation, read));

const unknownSecretSet = (secretSetId: string): Response =>
  problem(422, {
    code: "NotFound",
    title: "No such secret set",
    detail: `your tenant owns no secret set with the id ${secretSetId}`,
    fix: "List your secret sets and pass the secretSetId of one; a secret set's name is not its id",
  });

type PersonaBody = z.infer<typeof PersonaCreateSchema>;

type PersonaWritten = { ok: true; value: PersonaWrite } | { ok: false; response: Response };

const personaWrite = async (
  env: Env,
  caller: Caller,
  body: PersonaBody,
  operation: string,
  newSecretSet: boolean,
): Promise<PersonaWritten> => {
  const tenant = env.TENANT.getByName(caller.tenantId);
  const read = await tenant.getSecretSet(caller.tenantId, body.secretSetId);
  if (read.kind === "NotFound") return { ok: false, response: unknownSecretSet(body.secretSetId) };
  if (read.kind === "Unreadable") return { ok: false, response: unreadable(operation, read) };
  const stored = await personaFiles(
    env,
    caller.tenantId,
    {
      harness: body.harness,
      files: body.files ?? [],
      secretSetName: read.secretSet.name,
      members: read.secretSet.keys,
      pins: await tenant.listPins(),
      newSecretSet,
    },
    operation,
  );
  if (!stored.ok) return stored;
  return {
    ok: true,
    value: {
      name: body.name,
      harness: body.harness,
      secretSetId: body.secretSetId,
      files: stored.value,
    },
  };
};

const handlePersonaCreate = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, PersonaCreateSchema, "personas.create");
  if (!body.ok) return body.response;
  const write = await personaWrite(env, caller, body.value, "personas.create", true);
  if (!write.ok) return write.response;
  const tenant = env.TENANT.getByName(caller.tenantId);
  const created = await tenant.createPersona(caller.tenantId, write.value, Date.now());
  if (!created.ok) return conflict("personas.create", body.value.name, created.constraint);
  return json(PersonaSchema.parse(created.value));
};

const PERSONA_PATH = /^\/v1\/personas\/([^/]+)$/;

const handlePersona = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const matched = PERSONA_PATH.exec(url.pathname)?.[1];
  if (matched === undefined || !["GET", "PUT", "DELETE"].includes(request.method)) return null;
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const raw = decodeURIComponent(matched);
  const path = PersonaPathSchema.safeParse({ personaId: raw });
  if (!path.success) return personaNotFound(raw);
  const { personaId } = path.data;
  const tenant = env.TENANT.getByName(caller.tenantId);
  if (request.method === "DELETE") {
    const deleted = await tenant.deletePersona(caller.tenantId, personaId);
    if (deleted.kind === "Deleted") return noContent();
    if (deleted.kind === "NotFound") return personaNotFound(personaId);
    return problem(409, {
      code: "Conflict",
      title: "Persona in use",
      detail: `persona ${personaId} is the persona of session ${deleted.sessions.join(", ")}, which is not Failed`,
      fix: "A persona stays while any of its sessions is not Failed; point new work at another persona instead",
    });
  }
  if (request.method === "PUT") {
    const body = await parseBody(request, PersonaUpdateSchema, "personas.update");
    if (!body.ok) return body.response;
    const current = await tenant.getPersona(caller.tenantId, personaId);
    if (current === null) return personaNotFound(personaId);
    const write = await personaWrite(
      env,
      caller,
      { ...body.value, harness: current.harness },
      "personas.update",
      body.value.secretSetId !== current.secretSetId,
    );
    if (!write.ok) return write.response;
    const { harness: _fixed, ...change } = write.value;
    const updated = await tenant.updatePersona(caller.tenantId, personaId, change, Date.now());
    if (!updated.ok) return conflict("personas.update", body.value.name, updated.constraint);
    return updated.value === null ? personaNotFound(personaId) : json(PersonaSchema.parse(updated.value));
  }
  const persona = await tenant.getPersona(caller.tenantId, personaId);
  return persona === null ? personaNotFound(personaId) : json(PersonaSchema.parse(persona));
};

const handlePersonaFileUpload = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, PersonaFileUploadRequestSchema, "personas.uploadFile");
  if (!body.ok) return body.response;
  const now = Date.now();
  const key = personaFileKey(caller.tenantId, body.value.digest);
  return json(
    PersonaFileUploadSchema.parse({
      ...body.value,
      uploadUrl: await signerOf(env, env.R2_BUCKET_NAME, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY).presign(
        "PUT",
        key,
        UPLOAD_TTL_SECONDS,
        new Date(now),
      ),
      uploadExpiresAt: new Date(now + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    }),
  );
};

const handleSecretSetsList = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const read = await env.TENANT.getByName(caller.tenantId).listSecretSets(caller.tenantId);
  if (read.kind === "Unreadable") return unreadable("secretSets.list", read);
  return json(SecretSetSchema.array().parse(read.secretSets));
};

const handleSecretSetCreate = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, SecretSetCreateSchema, "secretSets.create");
  if (!body.ok) return body.response;
  const githubUser = await repositoryTokenUser(env, body.value.secrets, "secretSets.create");
  if (!githubUser.ok) return githubUser.response;
  const created = await env.TENANT.getByName(caller.tenantId).createSecretSet(
    caller.tenantId,
    body.value,
    githubUser.user,
    Date.now(),
  );
  if (!created.ok) return conflict("secretSets.create", body.value.name, created.constraint);
  return json(SecretSetSchema.parse(created.value));
};

const SECRET_SET_PATH = /^\/v1\/secret-sets\/([^/]+)$/;

const handleSecretSet = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const matched = SECRET_SET_PATH.exec(url.pathname)?.[1];
  if (matched === undefined || !["GET", "PUT", "DELETE"].includes(request.method)) return null;
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const raw = decodeURIComponent(matched);
  const path = SecretSetPathSchema.safeParse({ secretSetId: raw });
  if (!path.success) return secretSetNotFound(raw);
  const { secretSetId } = path.data;
  const tenant = env.TENANT.getByName(caller.tenantId);
  if (request.method === "DELETE") {
    const deleted = await tenant.deleteSecretSet(secretSetId);
    if (deleted.kind === "Deleted") return noContent();
    if (deleted.kind === "NotFound") return secretSetNotFound(secretSetId);
    return problem(409, {
      code: "Conflict",
      title: "Secret set in use",
      detail: `secret set ${secretSetId} is the secret set of persona ${deleted.personas.join(", ")}`,
      fix: "Point each of those personas at another secret set, or delete them, then delete the secret set",
    });
  }
  if (request.method === "PUT") {
    const body = await parseBody(request, SecretSetUpdateSchema, "secretSets.update");
    if (!body.ok) return body.response;
    const githubUser = await repositoryTokenUser(env, body.value.secrets, "secretSets.update");
    if (!githubUser.ok) return githubUser.response;
    const updated = await tenant.updateSecretSet(caller.tenantId, secretSetId, body.value, githubUser.user, Date.now());
    if (updated.kind === "Updated") return json(SecretSetSchema.parse(updated.secretSet));
    if (updated.kind === "SetNotFound") return secretSetNotFound(secretSetId);
    if (updated.kind === "Conflict") return conflict("secretSets.update", body.value.name, updated.constraint);
    if (updated.kind === "NoStoredValue") {
      return problem(422, {
        code: "InvalidRequest",
        title: "No stored value to keep",
        detail: `secretSets.update sent member ${updated.name} without a value, and secret set ${body.value.name} stores no member ${updated.source}`,
        fix: `Enter a value for ${updated.name}, or send previousName with the name it had before`,
      });
    }
    return problem(422, {
      code: "InvalidRequest",
      title: "GitHub token needs its value",
      detail: `secretSets.update renames member ${updated.source} to ${REPOSITORY_TOKEN} without a value; GitHub checks every new ${REPOSITORY_TOKEN} before it is stored`,
      fix: `Enter the value of ${REPOSITORY_TOKEN}`,
    });
  }
  const read = await tenant.getSecretSet(caller.tenantId, secretSetId);
  if (read.kind === "NotFound") return secretSetNotFound(secretSetId);
  if (read.kind === "Unreadable") return unreadable("secretSets.get", read);
  return json(SecretSetSchema.parse(read.secretSet));
};

const SECRET_MEMBERS_PATH = /^\/v1\/secret-sets\/([^/]+)\/members(?:\/([^/]+))?$/;

const handleSecretMember = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const matched = SECRET_MEMBERS_PATH.exec(url.pathname);
  if (matched === null) return null;
  const [, rawSet = "", rawName] = matched;
  const setting = request.method === "PUT" && rawName === undefined;
  const removing = request.method === "DELETE" && rawName !== undefined;
  if (!setting && !removing) return null;
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const secretSetPath = SecretSetPathSchema.safeParse({ secretSetId: decodeURIComponent(rawSet) });
  if (!secretSetPath.success) return secretSetNotFound(decodeURIComponent(rawSet));
  const { secretSetId } = secretSetPath.data;
  const tenant = env.TENANT.getByName(caller.tenantId);
  if (setting) {
    const body = await parseBody(request, SecretValueSchema, "secretSets.setMember");
    if (!body.ok) return body.response;
    const githubUser = await repositoryTokenUser(env, [body.value], "secretSets.setMember");
    if (!githubUser.ok) return githubUser.response;
    const written = await tenant.setSecretMember(caller.tenantId, secretSetId, body.value, githubUser.user, Date.now());
    if (written.kind === "Conflict") return conflict("secretSets.setMember", secretSetId, written.constraint);
    if (written.kind === "SetNotFound") return secretSetNotFound(secretSetId);
    if (written.kind === "Unreadable") return unreadable("secretSets.setMember", written);
    return json(SecretSetSchema.parse(written.secretSet));
  }
  const name = decodeURIComponent(rawName ?? "");
  const memberPath = SecretMemberPathSchema.safeParse({ secretSetId, name });
  const removed = memberPath.success
    ? await tenant.removeSecretMember(caller.tenantId, secretSetId, memberPath.data.name, Date.now())
    : { kind: "MemberNotFound" as const };
  if (removed.kind === "Removed") return json(SecretSetSchema.parse(removed.secretSet));
  if (removed.kind === "SetNotFound") return secretSetNotFound(secretSetId);
  if (removed.kind === "Unreadable") return unreadable("secretSets.removeMember", removed);
  return problem(404, {
    code: "NotFound",
    title: "No such member",
    detail: `secret set ${secretSetId} has no member ${name}`,
    fix: "Read the secret set and name one of its members",
  });
};

const handleHarnessCatalog = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(HarnessCatalogEntrySchema.array().parse(HARNESS_CATALOG));
};

const handlePinsList = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const pins = await env.TENANT.getByName(caller.tenantId).listPins();
  return json(EffectiveHarnessVersionSchema.array().parse(effectiveVersions(pins)));
};

const handlePin = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, HarnessPinCreateSchema, "harnessCatalog.pin");
  if (!body.ok) return body.response;
  const refused = await pinRefusal(env, caller.tenantId, body.value);
  if (refused !== null) return refused;
  const pinned = await env.TENANT.getByName(caller.tenantId).pin(body.value, Date.now());
  return json(HarnessPinSchema.parse(pinned));
};

const PIN_PATH = /^\/v1\/harnesses\/pins\/([^/]+)$/;

const handleUnpin = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const matched = PIN_PATH.exec(url.pathname)?.[1];
  if (matched === undefined || request.method !== "DELETE") return null;
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const raw = decodeURIComponent(matched);
  const path = HarnessPathSchema.safeParse({ harness: raw });
  const unpinned = path.success && (await env.TENANT.getByName(caller.tenantId).unpin(path.data.harness));
  if (unpinned) return noContent();
  return problem(404, {
    code: "NotFound",
    title: "No such pin",
    detail: `your tenant has no pin for harness ${raw}`,
    fix: "List your harness pins and name one of them",
  });
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
      fix: "List your devices and revoke one of their ids",
    });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

const refusal = (refused: Refused): Response => problem(refused.status, refused.problem);

const handleMint = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, EnrolmentTokenMintSchema, "mint");
  if (!body.ok) return body.response;
  return json(await mintEnrolmentToken(env.DB, caller, body.value.expiresInSeconds, url.origin, Date.now()));
};

const handleListEnrolmentTokens = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await listEnrolmentTokens(env.DB, caller.tenantId, Date.now()));
};

const ENROLMENT_TOKENS_PATH = "/v1/enrolment-tokens/";

const handleRevokeEnrolmentToken = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const enrolmentTokenId = decodeURIComponent(url.pathname.slice(ENROLMENT_TOKENS_PATH.length));
  const revoked = await revokeEnrolmentToken(env.DB, caller.tenantId, enrolmentTokenId, Date.now());
  return revoked.ok ? noContent() : refusal(revoked);
};

const handleEnrol = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const body = await parseBody(request, HostEnrolSchema, "enrol");
  if (!body.ok) return body.response;
  const enrolled = await enrolHost(env, body.value, Date.now());
  return enrolled.ok ? json(enrolled.value) : refusal(enrolled);
};

const handleListHosts = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await withSupervisorUpdates(env, caller.tenantId, await listHosts(env.DB, caller.tenantId)));
};

const handleListHostUsage = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await env.TENANT.getByName(caller.tenantId).listHostUsage(caller.tenantId));
};

const RELEASE_DOWNLOAD_PATH = /^\/v1\/releases\/(supervisor|cli)\/([^/]+)$/;

const RELEASE_BINARIES = {
  supervisor: {
    pathSchema: ReleaseSupervisorPathSchema,
    key: "supervisors",
    title: "No supervisor for this architecture",
    fix: "Run the host on one of those architectures, or publish a release that carries the supervisor for it",
  },
  cli: {
    pathSchema: ReleaseCliPathSchema,
    key: "clis",
    title: "No CLI for this architecture",
    fix: "Run the CLI on one of those architectures, or publish a release that carries the CLI for it",
  },
} as const;

const unreadableRelease = (detail: string): Response =>
  problem(503, {
    code: "ReleaseUnreadable",
    title: "The published release is unreadable",
    detail: `the published release is unreadable: ${detail}`,
    fix: "Publish a release with the release workflow, then try again",
  });

const handleCurrentRelease = async (_request: Request, _url: URL, env: Env): Promise<Response> => {
  const release = await readRelease(env.RELEASES, Date.now());
  if (release.kind === "Unpublished") return noRelease();
  if (release.kind === "Unreadable") return unreadableRelease(release.detail);
  return storedJson(release.stored);
};

const handleInstallScript = async (_request: Request, url: URL, env: Env): Promise<Response> => {
  const release = await readRelease(env.RELEASES, Date.now());
  if (release.kind === "Unpublished") return noRelease();
  if (release.kind === "Unreadable") return unreadableRelease(release.detail);
  const checksums = release.manifest.clis.map(({ architecture, sha256 }) => `${architecture} ${sha256}`).join("\n");
  const script = installScript.replaceAll("@TUMPEL_ORIGIN@", url.origin).replaceAll("@TUMPEL_CLI_SHA256S@", checksums);
  return new Response(script, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
};

const handleReleaseDownload = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const matched = RELEASE_DOWNLOAD_PATH.exec(url.pathname);
  if (matched?.[1] === undefined || matched[2] === undefined) return null;
  const kind = matched[1] === "cli" ? "cli" : "supervisor";
  const binary = RELEASE_BINARIES[kind];
  const browser = wantsHtml(request);
  const noBuild = (status: number, detail: string): Response => {
    const amd64 = new URL(`/v1/releases/${kind}/Amd64`, url.origin).href;
    return htmlPage(env, url, status, (links) => noBuildPage(links, kind, detail, amd64));
  };
  const parsed = binary.pathSchema.safeParse({ architecture: decodeURIComponent(matched[2]) });
  if (!parsed.success) {
    if (browser)
      return noBuild(400, `Releases build for Amd64 only, and this link asks for ${decodeURIComponent(matched[2])}`);
    return problem(400, {
      code: "InvalidRequest",
      title: "Unknown architecture",
      detail: `releases.${kind} refused the path: ${issues(parsed.error)}`,
      fix: "Ask for Amd64; releases build for Amd64 only",
    });
  }
  const { architecture } = parsed.data;
  const release = await readRelease(env.RELEASES, Date.now());
  if (release.kind === "Unpublished") {
    if (!browser) return noRelease();
    return htmlPage(env, url, 404, (links) => noReleasePage(links, url.href));
  }
  if (release.kind === "Unreadable") {
    if (!browser) return unreadableRelease(release.detail);
    return htmlPage(env, url, 503, (links) => unreadableReleasePage(links, url.href, release.detail));
  }
  const published = release.manifest[binary.key];
  const found = published.find((each) => each.architecture === architecture);
  if (found === undefined) {
    if (browser) {
      return noBuild(
        404,
        `Release ${release.manifest.releaseVersion} builds for ${published.map((each) => each.architecture).join(", ")}, and this link asks for ${architecture}`,
      );
    }
    return problem(404, {
      code: "NotFound",
      title: binary.title,
      detail: `release ${release.manifest.releaseVersion} carries ${binary.key} for ${published.map((each) => each.architecture).join(", ")}, not ${architecture}`,
      fix: binary.fix,
    });
  }
  return new Response(null, { status: 302, headers: { location: found.downloadUrl, "cache-control": "no-store" } });
};

const HOST_PATH = /^\/v1\/hosts\/([^/]+)(\/revoke|\/labels)?$/;

const handleHost = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const channel = CHANNEL_PATH.exec(url.pathname);
  if (request.method === "GET" && channel?.[1]) {
    return env.HOST.get(env.HOST.idFromName(decodeURIComponent(channel[1]))).fetch(request);
  }
  const matched = HOST_PATH.exec(url.pathname);
  const hostId = matched?.[1] === undefined ? "" : decodeURIComponent(matched[1]);
  const action = matched?.[2];
  const revoking = action === "/revoke";
  const method = { "/revoke": "POST", "/labels": "PUT" }[action ?? ""] ?? "GET";
  if (hostId === "" || request.method !== method) return null;
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  if (action === "/labels") {
    const body = await parseBody(request, HostLabelsSchema, "hosts.setLabels");
    if (!body.ok) return body.response;
    const labelled = await setHostLabels(env.DB, caller.tenantId, hostId, body.value.labels, Date.now());
    if (!labelled.ok) return refusal(labelled);
    const [host] = await withSupervisorUpdates(env, caller.tenantId, [labelled.value]);
    return json(host);
  }
  if (revoking) {
    const revoked = await revokeHost(env, caller.tenantId, hostId, Date.now());
    return revoked.ok ? json(revoked.value) : refusal(revoked);
  }
  const host = await hostOf(env.DB, caller.tenantId, hostId);
  if (host === null) return refusal(hostNotFound(hostId));
  const [withUpdates] = await withSupervisorUpdates(env, caller.tenantId, [host]);
  return json(withUpdates);
};

const handleDeviceStart = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const parsed = DeviceCodeRequestSchema.safeParse(await readParams(request));
  if (!parsed.success) return oauthError("invalid_request", issues(parsed.error));
  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { devicePollIntervalSeconds } = settingsOf(env);
  const started = await startDeviceCode(
    env.DB,
    parsed.data.device_name,
    clientIp,
    DEVICE_CODE_LIMITS,
    devicePollIntervalSeconds,
    Date.now(),
  );
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
      interval: devicePollIntervalSeconds,
    }),
  );
};

type Memberships = [Whoami, ...Whoami[]];

type Decision<T> = { ok: true; body: T; memberships: Memberships } | { ok: false; response: Response };

const notTheProofToken = (): Response =>
  problem(403, {
    code: "Forbidden",
    title: "Unknown service token",
    detail: "this Cloudflare Access service token is not the proof's service token",
    fix: "Sign in to Access as a person, or sign the proof in with the tumpel-proof service token of this stage",
  });

const signerMemberships = async (
  signed: Extract<Verification, { ok: true }>,
  url: URL,
  env: Env,
): Promise<Memberships | Response> => {
  if (signed.kind === "ServiceToken") {
    const expected = env.ACCESS_PROOF_COMMON_NAME ?? "";
    if (expected === "" || !sameSecret(signed.commonName, expected)) return notTheProofToken();
    const now = Date.now();
    const proof = await proofCaller(env.DB, signed.commonName, url.hostname, now);
    if (proof.created) {
      await env.TENANT.getByName(proof.caller.tenantId).open(proof.caller.tenantId, now);
    }
    return [await whoamiOf(env.DB, proof.caller)];
  }
  const [first, ...others] = await membershipsOfEmail(env.DB, signed.email);
  return first === undefined ? noTenant(url, signed.email) : [first, ...others];
};

const choicesOf = (memberships: Whoami[]): TenantChoice[] =>
  memberships.map((membership) => ({ tenantId: membership.tenant.tenantId, name: membership.tenant.name }));

const chosenCaller = (memberships: Whoami[], tenantId: string): Caller | null => {
  const chosen = memberships.find((membership) => membership.tenant.tenantId === tenantId);
  return chosen === undefined ? null : callerOf(chosen);
};

const notYourTenant = (tenantId: string): Response =>
  problem(403, {
    code: "Forbidden",
    title: "Not your tenant",
    detail: `you are no member of tenant ${tenantId}`,
    fix: "Choose one of the tenants the page lists",
  });

const readDecision = async <T>(
  request: Request,
  url: URL,
  env: Env,
  schema: z.ZodType<T>,
  operation: string,
): Promise<Decision<T>> => {
  const signed = await assertedSigner(request, env);
  if (!signed.ok) return { ok: false, response: browserSignedOut(url, signed.reason) };
  const refused = sameOriginJson(request, url);
  if (refused) return { ok: false, response: refused };
  const body = await parseBody(request, schema, operation);
  if (!body.ok) return body;
  const memberships = await signerMemberships(signed, url, env);
  if (memberships instanceof Response) return { ok: false, response: memberships };
  return { ok: true, body: body.value, memberships };
};

const codeNotFound = (typed: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "Code not found",
    detail: `the code ${typed} is wrong, expired or already decided`,
    fix: "Run tumpel login again and enter the code it prints",
  });

const handleDeviceApprove = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const decision = await readDecision(request, url, env, DeviceApprovalSchema, "approve");
  if (!decision.ok) return decision.response;
  const { userCode: typed, tenantId } = decision.body;
  const caller = chosenCaller(decision.memberships, tenantId);
  if (caller === null) return notYourTenant(tenantId);
  const userCode = parseUserCode(typed);
  const device = userCode === null ? null : await approveDeviceCode(env.DB, userCode, caller, Date.now());
  return device === null ? codeNotFound(typed) : json(device);
};

const handleDeviceDeny = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const decision = await readDecision(request, url, env, DeviceDecisionSchema, "deny");
  if (!decision.ok) return decision.response;
  const typed = decision.body.userCode;
  const userCode = parseUserCode(typed);
  if (userCode === null || !(await denyDeviceCode(env.DB, userCode, Date.now()))) return codeNotFound(typed);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

const handleIssuerHost = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const issuer = issuerOf(env);
  if (request.method === "GET" && url.pathname === OPENID_CONFIGURATION_PATH) {
    return json(OpenIdConfigurationSchema.parse(openIdConfiguration(issuer.issuer)), 200, ISSUER_DOCUMENT_HEADERS);
  }
  if (request.method === "GET" && url.pathname === JWKS_PATH) {
    return json(IssuerJwksSchema.parse({ keys: await issuer.publishedKeys() }), 200, {
      ...ISSUER_DOCUMENT_HEADERS,
      "cache-control": "public, max-age=300",
    });
  }
  return problem(404, {
    code: "NotFound",
    title: "No such issuer document",
    detail: `the issuer ${issuer.issuer} serves ${OPENID_CONFIGURATION_PATH} and ${JWKS_PATH} only, not ${request.method} ${url.pathname}`,
    fix: `GET ${issuer.issuer}${OPENID_CONFIGURATION_PATH}`,
  });
};

const handleDeviceToken = async (request: Request, env: Env): Promise<Response> => {
  const params = await readParams(request);
  if (params.grant_type !== DEVICE_GRANT) {
    return oauthError("unsupported_grant_type", `grant_type must be ${DEVICE_GRANT}`);
  }
  const parsed = DeviceTokenRequestSchema.safeParse(params);
  if (!parsed.success) return oauthError("invalid_request", issues(parsed.error));
  const outcome = await pollDeviceCode(
    env.DB,
    parsed.data.device_code,
    settingsOf(env).deviceSlowDownStepSeconds,
    Date.now(),
  );
  if (!outcome.ok) return oauthError(outcome.error, GRANT_ERRORS[outcome.error]);
  return json(DeviceTokenSchema.parse({ access_token: outcome.accessToken, token_type: "Bearer" }));
};

const handleDevicePage = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const signed = await assertedEmail(request, env);
  if (!signed.ok) return htmlPage(env, url, 401, (links) => signInAgainPage(links, signed.reason, url.href));
  const { email } = signed;
  const memberships = await membershipsOfEmail(env.DB, email);
  if (memberships.length === 0) return htmlPage(env, url, 200, (links) => signUpPage(links, email));
  const typed = url.searchParams.get("code") ?? "";
  if (typed === "") return htmlPage(env, url, 200, (links) => enterCodePage(links, email));
  const userCode = parseUserCode(typed);
  const pending = userCode === null ? null : await pendingDeviceCode(env.DB, userCode, Date.now());
  if (pending === null) return htmlPage(env, url, 404, (links) => codeNotFoundPage(links, email));
  const deviceRequest = {
    email,
    tenants: choicesOf(memberships),
    userCode: formatUserCode(pending.userCode),
    deviceName: pending.deviceName,
  };
  return htmlPage(env, url, 200, (links, context) => confirmPage(links, deviceRequest, context));
};

const allowedOrigins = (env: Env): string[] => [...CONNECTOR_ORIGINS, dashboardOrigin(env)];

const corsHeaders = (request: Request, env: Env): Record<string, string> => {
  const allowed = allowedOrigins(env);
  const origin = request.headers.get("origin");
  if (origin === null || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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
      { "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${SCOPE}"` },
    );
  }
  const now = Date.now();
  const caller = (await callerForAccessToken(env.DB, token, now)) ?? (await callerForDeviceToken(env.DB, token, now));
  if (caller === null) {
    return mcpRefusal(
      401,
      {
        code: "SignedOut",
        title: "Not signed in",
        detail: "this access token is unknown, expired or revoked",
        fix: "Connect the connector again",
      },
      { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}", scope="${SCOPE}"` },
    );
  }
  return caller;
};

const asConnector =
  (env: Env, caller: Caller): Dispatch =>
  async (request) => {
    connectorCallers.set(request, caller);
    return dispatch(request, new URL(request.url), env);
  };

const handleMcp = (request: Request, env: Env): Promise<Response> =>
  mcpEndpoint(request, async () => {
    const caller = await mcpCaller(request, env);
    return caller instanceof Response ? caller : asConnector(env, caller);
  });

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

const handleAuthorize = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const ask = readAuthorizeAsk(url);
  const client = ask.clientId === "" ? null : await clientFor(env.DB, ask.clientId);
  if (client === null) {
    if (wantsHtml(request)) return htmlPage(env, url, 400, (links) => unknownClientPage(links));
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

const consentClient = (request: { clientName: string; redirectUri: string }): ConsentClient => {
  const callbackOrigin = new URL(request.redirectUri).origin;
  return {
    clientName: request.clientName,
    callbackOrigin,
    returnUrl: CONNECTOR_ORIGINS.includes(callbackOrigin) ? callbackOrigin : null,
  };
};

const handleConsent = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const asserted = await assertedSigner(request, env);
  if (!asserted.ok) return htmlPage(env, url, 401, (links) => signInAgainPage(links, asserted.reason, url.href));
  if (request.method === "GET" && asserted.kind === "Person") {
    const asked = await pendingAuthorization(env.DB, url.searchParams.get("request") ?? "", Date.now());
    const tenantless = (await membershipsOfEmail(env.DB, asserted.email)).length === 0;
    if (asked?.firstParty === true && tenantless) {
      return htmlPage(env, url, 200, (links) => signUpPage(links, asserted.email));
    }
    if (tenantless && wantsHtml(request)) {
      return htmlPage(env, url, 403, (links) => noTenantPage(links, asserted.email));
    }
  }
  const memberships = await signerMemberships(asserted, url, env);
  if (memberships instanceof Response) return memberships;
  const [first, ...others] = memberships;
  const email = first.principal.email;
  const expired = async (requestId: string): Promise<Response> => {
    const known = await requestClient(env.DB, requestId);
    if (known === null) return htmlPage(env, url, 404, (links) => nothingToConnectPage(links, email, null));
    const client = consentClient(known);
    if (known.spent) return htmlPage(env, url, 200, (links) => alreadyApprovedPage(links, email, client));
    return htmlPage(env, url, 404, (links) => nothingToConnectPage(links, email, client));
  };
  if (request.method === "GET") {
    const requestId = url.searchParams.get("request") ?? "";
    const asked = await pendingAuthorization(env.DB, requestId, Date.now());
    if (asked === null) return expired(requestId);
    if (asked.firstParty && others.length === 0) {
      const code = await grantCode(env.DB, asked, callerOf(first), Date.now());
      if (code === null) return expired(requestId);
      return seeOther(redirectBack(asked.redirectUri, asked.state, url.origin, { code }));
    }
    const csrf = randomToken();
    const consent = {
      ...consentClient(asked),
      email,
      tenants: choicesOf(memberships),
      requestId: asked.requestId,
      csrf,
    };
    return withHeaders(
      htmlPage(env, url, 200, (links) => consentPage(links, consent), [consent.callbackOrigin]),
      { "set-cookie": `${CONSENT_CSRF_COOKIE}=${csrf}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict` },
    );
  }
  const form = new URLSearchParams(await request.text());
  const cookie = readCookie(request.headers.get("cookie"), CONSENT_CSRF_COOKIE);
  const csrf = form.get("csrf") ?? "";
  const requestId = form.get("request") ?? "";
  if (request.headers.get("origin") !== url.origin || cookie === null || !sameSecret(cookie, csrf)) {
    const known = await requestClient(env.DB, requestId);
    const client = known === null ? null : consentClient(known);
    return htmlPage(env, url, 403, (links) => consentRefusedPage(links, email, "CrossSite", client));
  }
  const asked = await pendingAuthorization(env.DB, requestId, Date.now());
  if (asked === null) return expired(requestId);
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
  if (action !== "approve")
    return htmlPage(env, url, 400, (links) => consentRefusedPage(links, email, "NoAction", consentClient(asked)));
  const caller = chosenCaller(memberships, form.get("tenant") ?? "");
  if (caller === null)
    return htmlPage(env, url, 403, (links) => consentRefusedPage(links, email, "NotYourTenant", consentClient(asked)));
  const code = await grantCode(env.DB, asked, caller, Date.now());
  if (code === null) return expired(requestId);
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

const handleRevoke = async (request: Request, env: Env): Promise<Response> => {
  const parsed = OAuthRevocationRequestSchema.safeParse(await readParams(request));
  if (!parsed.success) return oauthError("invalid_request", issues(parsed.error));
  const refused = await revokeToken(env.DB, parsed.data.token, parsed.data.client_id);
  return refused === null
    ? new Response(null, { status: 200, headers: { "cache-control": "no-store" } })
    : oauthError(refused.error, refused.description);
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
  [`POST ${SIGN_UP_PATH}`]: handleSignUp,
  "GET /v1/whoami": (request, _url, env) => handleWhoami(request, env),
  "GET /v1/whoami/tenants": (request, _url, env) => handleListTenants(request, env),
  "POST /v1/device/code": handleDeviceStart,
  [`POST ${DEVICE_APPROVE_PATH}`]: handleDeviceApprove,
  [`POST ${DEVICE_DENY_PATH}`]: handleDeviceDeny,
  "GET /v1/devices": (request, _url, env) => handleDevicesList(request, env),
  "GET /v1/oauth-grants": (request, _url, env) => handleGrantsList(request, env),
  "POST /v1/tenant-config/plan": handleConfigPlan,
  "POST /v1/tenant-config/apply": handleConfigApply,
  "GET /v1/personas": (request, _url, env) => handlePersonasList(request, env),
  "POST /v1/personas": handlePersonaCreate,
  "POST /v1/personas/file-uploads": handlePersonaFileUpload,
  "GET /v1/secret-sets": handleSecretSetsList,
  "POST /v1/secret-sets": handleSecretSetCreate,
  "GET /v1/harnesses": handleHarnessCatalog,
  "GET /v1/harnesses/pins": handlePinsList,
  "PUT /v1/harnesses/pins": handlePin,
  "POST /v1/device/token": (request, _url, env) => handleDeviceToken(request, env),
  "POST /v1/enrolment-tokens": handleMint,
  "GET /v1/enrolment-tokens": handleListEnrolmentTokens,
  "POST /v1/hosts/enrol": handleEnrol,
  "GET /v1/hosts": handleListHosts,
  "GET /v1/hosts/usage": handleListHostUsage,
  "GET /v1/releases/current": handleCurrentRelease,
  "GET /v1/releases/rollout": handleReleaseRollout,
  "GET /v1/releases/install.sh": handleInstallScript,
  [`GET ${DEVICE_PAGE}`]: handleDevicePage,
  [`POST ${MCP_PATH}`]: (request, _url, env) => handleMcp(request, env),
  [`GET ${MCP_PATH}`]: (request, _url, env) => handleMcp(request, env),
  [`POST ${REGISTER_PATH}`]: (request, _url, env) => handleRegister(request, env),
  [`GET ${AUTHORIZE_PATH}`]: handleAuthorize,
  [`GET ${CONSENT_PATH}`]: handleConsent,
  [`POST ${CONSENT_PATH}`]: handleConsent,
  [`POST ${TOKEN_PATH}`]: handleToken,
  [`POST ${REVOKE_PATH}`]: (request, _url, env) => handleRevoke(request, env),
};

const dispatch = async (request: Request, url: URL, env: Env): Promise<Response> => {
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
  const deleting = request.method === "DELETE";
  if (deleting && url.pathname.startsWith(OAUTH_GRANTS_PATH) && url.pathname.length > OAUTH_GRANTS_PATH.length) {
    return handleGrantRevoke(request, url, env);
  }
  if (
    deleting &&
    url.pathname.startsWith(ENROLMENT_TOKENS_PATH) &&
    url.pathname.length > ENROLMENT_TOKENS_PATH.length
  ) {
    return handleRevokeEnrolmentToken(request, url, env);
  }
  const resource =
    (await handlePersona(request, url, env)) ??
    (await handleSecretSet(request, url, env)) ??
    (await handleSecretMember(request, url, env)) ??
    (await handleUnpin(request, url, env));
  if (resource) return resource;
  const sessions = await handleSessions(request, url, env, deviceCaller);
  if (sessions) return sessions;
  const uploads =
    (await handlePrebuildUploads(request, url, env)) ??
    (await handlePrebuildInputs(request, url, env)) ??
    (await handleCircleCIEvents(request, url, env));
  if (uploads) return uploads;
  const prebuilds = await handlePrebuilds(request, url, env, deviceCaller);
  if (prebuilds) return prebuilds;
  const metrics = await handleMetrics(request, url, env, deviceCaller);
  if (metrics) return metrics;
  const claudeSetups = await handleClaudeSetups(request, url, env, deviceCaller);
  if (claudeSetups) return claudeSetups;
  const connections =
    (await handleConnections(request, url, env, deviceCaller)) ??
    (await handleCircleCIAuthorizations(request, url, env, deviceCaller)) ??
    (await handleOpenRouterAuthorizations(request, url, env, deviceCaller)) ??
    (await handleOpenRouterCallback(request, url, env)) ??
    (await handleCircleCIProjects(request, url, env, deviceCaller));
  if (connections) return connections;
  const members = await handleMembers(request, url, env, {
    authenticate: deviceCaller,
    signedIn: assertedEmail,
    sameOrigin: sameOriginJson,
    signedOut: browserSignedOut,
  });
  if (members) return members;
  const github =
    (await handleGitHubConnection(request, url, env, deviceCaller)) ??
    (await handleGitHubPage(request, url, env, assertedEmail)) ??
    (await handleGitHubWebhook(request, url, env));
  if (github) return github;
  const host = await handleHost(request, url, env);
  if (host) return host;
  if (request.method === "GET") {
    const download = await handleReleaseDownload(request, url, env);
    if (download) return download;
  }
  if (wantsHtml(request)) {
    return htmlPage(env, url, 404, (links) => noSuchPage(links, url.pathname));
  }
  return problem(404, {
    code: "NotFound",
    title: "No such route",
    detail: `No route for ${request.method} ${url.pathname}`,
    fix: "Call /healthz or an operation of the tumpel contract in typespec",
  });
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === env.ISSUER_HOSTNAME) return handleIssuerHost(request, url, env);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "cache-control": "no-store" } });
    }
    return withHeaders(await dispatch(request, url, env), cors);
  },
  async queue(batch, env): Promise<void> {
    await noticeRelease(
      env,
      batch.messages.map((message) => message.body),
      Date.now(),
    );
  },
} satisfies ExportedHandler<Env>;
