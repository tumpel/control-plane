import {
  DeviceAuthorizationSchema,
  DeviceCodeRequestSchema,
  DeviceDecisionSchema,
  DeviceTokenRequestSchema,
  DeviceTokenSchema,
  EnrolmentTokenMintSchema,
  HarnessCatalogEntrySchema,
  HarnessPathSchema,
  HarnessPinCreateSchema,
  HarnessPinSchema,
  HealthSchema,
  HostEnrolSchema,
  HostLabelsSchema,
  OAuthAuthorizationCodeRequestSchema,
  OAuthClientRegistrationSchema,
  OAuthRefreshTokenRequestSchema,
  PersonaCreateSchema,
  PersonaFileUploadRequestSchema,
  PersonaFileUploadSchema,
  PersonaPathSchema,
  PersonaSchema,
  PersonaUpdateSchema,
  SecretSetCreateSchema,
  SecretSetPathSchema,
  SecretSetSchema,
  SecretSetUpdateSchema,
  SignUpSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { accessVerifier, cachedAccessKeys, type Verification, type Verify } from "./access";
import { CHANNEL_PATH } from "./channel/protocol.ts";
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
import { checkCredential } from "./dispatch-variables.ts";
import { handleGitHubConnection, handleGitHubPage, handleGitHubWebhook } from "./github-handlers.ts";
import { HARNESS_CATALOG, inCatalog, pinnedEntry } from "./harness-catalog";
import type { HostChannel } from "./host-channel";
import {
  enrolHost,
  hostNotFound,
  hostOf,
  listHosts,
  mintEnrolmentToken,
  type Refused,
  revokeHost,
  setHostLabels,
} from "./hosts";
import { issues, json, oauthError, parseBody, problem, readJson, readParams, seeOther, signedOut } from "./http";
import { bearerOf, type Caller, callerForDeviceToken, proofCaller, signUp, whoamiForEmail, whoamiOf } from "./identity";
import { type Dispatch, mcpEndpoint, mcpRefusal } from "./mcp";
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
import { checkFiles, personaFileKey, storeFiles, UPLOAD_TTL_SECONDS } from "./persona-files";
import { type SignerEnv, signerOf } from "./presign";
import type { SessionTimer } from "./session-timer";
import { credentialRefused, handleSessions } from "./sessions";
import type { PersonaWrite, Tenant } from "./tenant";

export { HostChannel } from "./host-channel";
export { SessionTimer } from "./session-timer";
export { Tenant } from "./tenant";

export interface Env extends SignerEnv {
  DB: D1Database;
  TENANT: DurableObjectNamespace<Tenant>;
  HOST: DurableObjectNamespace<HostChannel>;
  SESSION_TIMER: DurableObjectNamespace<SessionTimer>;
  STORE: R2Bucket;
  TUMPEL_SETTINGS: unknown;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
  ACCESS_PROOF_COMMON_NAME?: string;
  SECRETS_KEK?: string;
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
  const { name, gitAuthorName, gitAuthorEmail } = body.value;
  const whoami = await signUp(env.DB, signed.email, name, now);
  await env.TENANT.getByName(whoami.tenant.tenantId).open(
    whoami.tenant.tenantId,
    { gitAuthorName, gitAuthorEmail },
    now,
  );
  return json(WhoamiSchema.parse(whoami));
};

const connectorCallers = new WeakMap<Request, Caller>();

const deviceCaller = async (request: Request, env: Env): Promise<Caller | Response> => {
  const connector = connectorCallers.get(request);
  if (connector !== undefined) return connector;
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

const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

const personaNotFound = (personaId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such persona",
    detail: `your tenant owns no persona ${personaId}`,
    fix: "List the personas with GET /v1/personas and use one of the ids it returns",
  });

const secretSetNotFound = (secretSetId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such secret set",
    detail: `your tenant owns no secret set ${secretSetId}`,
    fix: "List the secret sets with GET /v1/secret-sets and use one of the ids it returns",
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
      detail: `${operation} gives secret set ${name} more than one ApiKey or SubscriptionToken for the same provider`,
      fix: "Keep one credential per provider in a secret set; put the other in a secret set of its own",
    });
  }
  return problem(409, {
    code: "Conflict",
    title: "Name taken",
    detail: `${operation} refused the name ${name}: your tenant already has one by that name (${constraint})`,
    fix: "Pick another name, or update the existing one",
  });
};

const unknownSecretSet = (operation: string, secretSetId: string): Response =>
  problem(422, {
    code: "NotFound",
    title: "No such secret set",
    detail: `${operation} names secret set ${secretSetId}, which your tenant does not own`,
    fix: "List the secret sets with GET /v1/secret-sets and name one of the ids it returns",
  });

type PersonaBody = z.infer<typeof PersonaCreateSchema>;

type PersonaWritten = { ok: true; value: PersonaWrite } | { ok: false; response: Response };

const personaWrite = async (
  env: Env,
  caller: Caller,
  body: PersonaBody,
  operation: string,
): Promise<PersonaWritten> => {
  const tenant = env.TENANT.getByName(caller.tenantId);
  const secretSet = await tenant.getSecretSet(caller.tenantId, body.secretSetId);
  if (secretSet === null) {
    return { ok: false, response: unknownSecretSet(operation, body.secretSetId) };
  }
  const entry = pinnedEntry(await tenant.listPins(), body.harness);
  if (entry === undefined) {
    return {
      ok: false,
      response: problem(422, {
        code: "HarnessNotInCatalog",
        title: "Harness not in the catalog",
        detail: `${operation} names ${body.harness}, of which the catalog holds no version your tenant can run`,
        fix: "Name a harness GET /v1/harnesses lists, or pin one of its listed versions",
      }),
    };
  }
  const credential = checkCredential(entry, secretSet.keys, Date.now());
  if (credential.kind === "Unsupported") {
    const refused = credentialRefused(credential, `secret set ${secretSet.name}`, body.harness, `repeat ${operation}`);
    return { ok: false, response: problem(refused.status, refused.problem) };
  }
  const checked = await checkFiles(entry, body.files, operation);
  if (!checked.ok) return { ok: false, response: problem(422, checked.problem) };
  const stored = await storeFiles(env.STORE, caller.tenantId, checked.files, operation);
  if (!stored.ok) return { ok: false, response: problem(422, stored.problem) };
  return {
    ok: true,
    value: {
      name: body.name,
      harness: body.harness,
      secretSetId: body.secretSetId,
      gitAuthorName: body.gitAuthorName,
      gitAuthorEmail: body.gitAuthorEmail,
      files: stored.files,
    },
  };
};

const handlePersonaCreate = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, PersonaCreateSchema, "personas.create");
  if (!body.ok) return body.response;
  const write = await personaWrite(env, caller, body.value, "personas.create");
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
      detail: `persona ${personaId} is the persona of session ${deleted.sessions.join(", ")}`,
      fix: "A persona that sessions ran on stays; point new work at another persona instead",
    });
  }
  if (request.method === "PUT") {
    const body = await parseBody(request, PersonaUpdateSchema, "personas.update");
    if (!body.ok) return body.response;
    const current = await tenant.getPersona(caller.tenantId, personaId);
    if (current === null) return personaNotFound(personaId);
    const write = await personaWrite(env, caller, { ...body.value, harness: current.harness }, "personas.update");
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
      uploadUrl: await signerOf(env).presign("PUT", key, UPLOAD_TTL_SECONDS, new Date(now)),
      uploadExpiresAt: new Date(now + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    }),
  );
};

const handleSecretSetsList = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const sets = await env.TENANT.getByName(caller.tenantId).listSecretSets(caller.tenantId);
  return json(SecretSetSchema.array().parse(sets));
};

const handleSecretSetCreate = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, SecretSetCreateSchema, "secretSets.create");
  if (!body.ok) return body.response;
  const created = await env.TENANT.getByName(caller.tenantId).createSecretSet(caller.tenantId, body.value, Date.now());
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
    const updated = await tenant.updateSecretSet(caller.tenantId, secretSetId, body.value, Date.now());
    if (!updated.ok) return conflict("secretSets.update", body.value.name, updated.constraint);
    return updated.value === null ? secretSetNotFound(secretSetId) : json(SecretSetSchema.parse(updated.value));
  }
  const secretSet = await tenant.getSecretSet(caller.tenantId, secretSetId);
  return secretSet === null ? secretSetNotFound(secretSetId) : json(SecretSetSchema.parse(secretSet));
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
  return json(HarnessPinSchema.array().parse(pins));
};

const handlePin = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  const body = await parseBody(request, HarnessPinCreateSchema, "harnessCatalog.pin");
  if (!body.ok) return body.response;
  if (!inCatalog(body.value.harness, body.value.harnessVersion)) {
    return problem(422, {
      code: "HarnessNotInCatalog",
      title: "Harness version not in the catalog",
      detail: `the catalog has no ${body.value.harness} ${body.value.harnessVersion}`,
      fix: "Pin a version GET /v1/harnesses lists",
    });
  }
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
    fix: "List the pins with GET /v1/harnesses/pins",
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
      fix: "Run tumpel devices list and revoke one of the ids it prints",
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

const handleEnrol = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const body = await parseBody(request, HostEnrolSchema, "enrol");
  if (!body.ok) return body.response;
  const enrolled = await enrolHost(env, body.value, Date.now());
  return enrolled.ok ? json(enrolled.value) : refusal(enrolled);
};

const handleListHosts = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await listHosts(env.DB, caller.tenantId));
};

const handleListHostUsage = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const caller = await deviceCaller(request, env);
  if (caller instanceof Response) return caller;
  return json(await env.TENANT.getByName(caller.tenantId).listHostUsage(caller.tenantId));
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
    return labelled.ok ? json(labelled.value) : refusal(labelled);
  }
  if (revoking) {
    const revoked = await revokeHost(env, caller.tenantId, hostId, Date.now());
    return revoked.ok ? json(revoked.value) : refusal(revoked);
  }
  const host = await hostOf(env.DB, caller.tenantId, hostId);
  return host === null ? refusal(hostNotFound(hostId)) : json(host);
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

const notTheProofToken = (): Response =>
  problem(403, {
    code: "Forbidden",
    title: "Unknown service token",
    detail: "this Cloudflare Access service token is not the proof's service token",
    fix: "Sign in to Access as a person, or sign the proof in with the tumpel-proof service token of this stage",
  });

const decidingCaller = async (
  signed: Extract<Verification, { ok: true }>,
  url: URL,
  env: Env,
): Promise<Caller | Response> => {
  if (signed.kind === "ServiceToken") {
    const expected = env.ACCESS_PROOF_COMMON_NAME ?? "";
    if (expected === "" || !sameSecret(signed.commonName, expected)) return notTheProofToken();
    const now = Date.now();
    const proof = await proofCaller(env.DB, signed.commonName, url.hostname, now);
    if (proof.created) {
      await env.TENANT.getByName(proof.caller.tenantId).open(proof.caller.tenantId, proof.identity, now);
    }
    return proof.caller;
  }
  const owner = await whoamiForEmail(env.DB, signed.email);
  if (owner === null) return noTenant(url, signed.email);
  return { tenantId: owner.tenant.tenantId, principalId: owner.principal.principalId };
};

const readDecision = async (request: Request, url: URL, env: Env, operation: string): Promise<Decision> => {
  const signed = await assertedSigner(request, env);
  if (!signed.ok) return { ok: false, response: browserSignedOut(url, signed.reason) };
  const refused = sameOriginJson(request, url);
  if (refused) return { ok: false, response: refused };
  const body = await parseBody(request, DeviceDecisionSchema, operation);
  if (!body.ok) return body;
  const caller = await decidingCaller(signed, url, env);
  if (caller instanceof Response) return { ok: false, response: caller };
  return { ok: true, caller, userCode: parseUserCode(body.value.userCode), typed: body.value.userCode };
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

const asConnector =
  (env: Env, caller: Caller): Dispatch =>
  async (request) => {
    connectorCallers.set(request, caller);
    return dispatch(request, new URL(request.url), env);
  };

const handleMcp = async (request: Request, env: Env): Promise<Response> => {
  if (request.method === "OPTIONS") return preflight(request);
  const answered = await mcpEndpoint(request, async () => {
    const caller = await mcpCaller(request, env);
    return caller instanceof Response ? caller : asConnector(env, caller);
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

type Consenter = { ok: true; caller: Caller; email: string } | { ok: false; response: Response };

const consenter = async (request: Request, url: URL, env: Env): Promise<Consenter> => {
  const signed = await assertedSigner(request, env);
  if (!signed.ok) return { ok: false, response: messagePage(401, "Sign in again", `${signed.reason}.`) };
  if (signed.kind === "ServiceToken") {
    const caller = await decidingCaller(signed, url, env);
    if (caller instanceof Response) return { ok: false, response: caller };
    return { ok: true, caller, email: (await whoamiOf(env.DB, caller)).principal.email };
  }
  const owner = await whoamiForEmail(env.DB, signed.email);
  if (owner === null) {
    return {
      ok: false,
      response: messagePage(
        403,
        "No tenant",
        `${signed.email} belongs to no tenant. Create one at ${url.origin}${DEVICE_PAGE}.`,
      ),
    };
  }
  return {
    ok: true,
    caller: { tenantId: owner.tenant.tenantId, principalId: owner.principal.principalId },
    email: signed.email,
  };
};

const handleConsent = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const signed = await consenter(request, url, env);
  if (!signed.ok) return signed.response;
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
  const code = await grantCode(env.DB, asked, signed.caller.principalId, Date.now());
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
  "POST /v1/personas": handlePersonaCreate,
  "POST /v1/personas/file-uploads": handlePersonaFileUpload,
  "GET /v1/secret-sets": handleSecretSetsList,
  "POST /v1/secret-sets": handleSecretSetCreate,
  "GET /v1/harnesses": handleHarnessCatalog,
  "GET /v1/harnesses/pins": handlePinsList,
  "PUT /v1/harnesses/pins": handlePin,
  "POST /v1/device/token": (request, _url, env) => handleDeviceToken(request, env),
  "POST /v1/enrolment-tokens": handleMint,
  "POST /v1/hosts/enrol": handleEnrol,
  "GET /v1/hosts": handleListHosts,
  "GET /v1/hosts/usage": handleListHostUsage,
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
  const resource =
    (await handlePersona(request, url, env)) ??
    (await handleSecretSet(request, url, env)) ??
    (await handleUnpin(request, url, env));
  if (resource) return resource;
  const sessions = await handleSessions(request, url, env, deviceCaller);
  if (sessions) return sessions;
  const github =
    (await handleGitHubConnection(request, url, env, deviceCaller)) ??
    (await handleGitHubPage(request, url, env, assertedEmail)) ??
    (await handleGitHubWebhook(request, url, env));
  if (github) return github;
  const host = await handleHost(request, url, env);
  if (host) return host;
  return problem(404, {
    code: "NotFound",
    title: "No such route",
    detail: `No route for ${request.method} ${url.pathname}`,
    fix: "Call /healthz or an operation of the tumpel contract in packages/api",
  });
};

export default {
  async fetch(request, env): Promise<Response> {
    return dispatch(request, new URL(request.url), env);
  },
} satisfies ExportedHandler<Env>;
