import type {
  CircleCIAuthorizationFailureReasonSchema,
  CircleCIAuthorizationSchema,
  CircleCIOrganizationSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import type { Fetch } from "./github.ts";

export type CircleCIAuthorization = z.infer<typeof CircleCIAuthorizationSchema>;
export type CircleCIAuthorizationFailureReason = z.infer<typeof CircleCIAuthorizationFailureReasonSchema>;
export type CircleCIOrganization = z.infer<typeof CircleCIOrganizationSchema>;

export type CircleCICredentialRow = { kind: "Authorized"; expiresAt: number } | { kind: "Pasted" };

export const CIRCLECI_REDIRECT_URI = "http://127.0.0.1:47151/circleci/callback";
export const CIRCLECI_CLIENT_NAME = "Tumpel";
export const REDIRECT_BUDGET_SECONDS = 600;
export const CHOOSE_BUDGET_SECONDS = 600;
export const RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const CIRCLECI_OAUTH_TIMEOUT_MS = 10_000;

const oauthUrl = (appOrigin: string, path: string): string => `${appOrigin.replace(/\/+$/, "")}${path}`;
const AUTHORIZE_AGAIN = "connect CircleCI again from the dashboard or with tumpel circleci authorize";

export type CircleCIRedirect =
  | { kind: "Code"; code: string; state: string }
  | { kind: "Denied"; error: string; description: string; state: string }
  | { kind: "Invalid"; detail: string };

const PASTE_FIX = `paste the whole address the browser shows after you choose Allow on CircleCI's page, starting with ${CIRCLECI_REDIRECT_URI}`;

export const parseRedirect = (raw: string, redirectUri: string): CircleCIRedirect => {
  const text = raw.trim();
  if (!URL.canParse(text)) return { kind: "Invalid", detail: `the pasted text is not an address; ${PASTE_FIX}` };
  const url = new URL(text);
  const expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    return {
      kind: "Invalid",
      detail: `the pasted address is ${url.origin}${url.pathname}, not the redirect address ${redirectUri}; ${PASTE_FIX}`,
    };
  }
  const one = (name: string): string | null => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 && values[0] !== "" ? (values[0] ?? null) : null;
  };
  const state = one("state");
  if (state === null) {
    return { kind: "Invalid", detail: `the pasted address carries no single state parameter; ${PASTE_FIX}` };
  }
  const error = one("error");
  if (error !== null) return { kind: "Denied", error, description: one("error_description") ?? "", state };
  const code = one("code");
  if (code === null) {
    return { kind: "Invalid", detail: `the pasted address carries neither a code nor an error; ${PASTE_FIX}` };
  }
  return { kind: "Code", code, state };
};

export const deniedDetail = (redirect: Extract<CircleCIRedirect, { kind: "Denied" }>): string =>
  `CircleCI sent the browser back with ${redirect.error}${redirect.description === "" ? "" : `: ${redirect.description}`}; choose Allow on CircleCI's page and ${AUTHORIZE_AGAIN}`;

export const stateMismatchDetail = (circleCIAuthorizationId: string): string =>
  `the pasted address carries another state than CircleCI authorization ${circleCIAuthorizationId} sent, so it belongs to another authorization; paste the address of the CircleCI tab this authorization opened`;

export const timedOutDetail = (circleCIAuthorizationId: string, phase: string): string =>
  phase === "ChoosingOrganization"
    ? `no organization was chosen for CircleCI authorization ${circleCIAuthorizationId} within ${CHOOSE_BUDGET_SECONDS / 60} minutes and its token was discarded; ${AUTHORIZE_AGAIN}`
    : `no redirect address reached CircleCI authorization ${circleCIAuthorizationId} within ${REDIRECT_BUDGET_SECONDS / 60} minutes; ${AUTHORIZE_AGAIN} and paste the address within that time`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const organizationsOf = (
  collaborations: readonly { id: string | null; name: string; slug: string }[],
): CircleCIOrganization[] => {
  const seen = new Map<string, CircleCIOrganization>();
  for (const { id, name, slug } of collaborations) {
    if (id === null || !UUID.test(id) || seen.has(id)) continue;
    const label = (name.trim() || slug).slice(0, 100);
    seen.set(id, { organizationId: id, name: label, slug });
  }
  return [...seen.values()];
};

export type CredentialStanding =
  | { state: "Connected" }
  | { state: "Expiring"; expiresAt: string }
  | { state: "Expired"; expiredAt: string };

export const credentialStanding = (credential: CircleCICredentialRow, now: number): CredentialStanding => {
  if (credential.kind === "Pasted") return { state: "Connected" };
  const { expiresAt } = credential;
  const at = new Date(expiresAt).toISOString();
  if (expiresAt <= now) return { state: "Expired", expiredAt: at };
  if (expiresAt - now <= RENEWAL_WINDOW_MS) return { state: "Expiring", expiresAt: at };
  return { state: "Connected" };
};

export const authorizeUrl = (
  appOrigin: string,
  request: { clientId: string; redirectUri: string; challenge: string; state: string },
): string => {
  const url = new URL(oauthUrl(appOrigin, "/oauth/authorize"));
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
    state: request.state,
  }).toString();
  return url.toString();
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const failed = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const ErrorBodySchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

const errorText = (text: string): string => {
  const body = ErrorBodySchema.safeParse(parseJson(text));
  if (!body.success) return "no error message";
  return (
    [body.data.error, body.data.error_description, body.data.message].filter(Boolean).join(": ") || "no error message"
  );
};

const RegisteredSchema = z.object({ client_id: z.string().min(1) });

export type ClientRegistration = { kind: "Registered"; clientId: string } | { kind: "Refused"; detail: string };

export const registerClient = async (
  fetcher: Fetch,
  appOrigin: string,
  redirectUri: string,
): Promise<ClientRegistration> => {
  const response = await fetcher(oauthUrl(appOrigin, "/oauth/register"), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "tumpel" },
    body: JSON.stringify({
      client_name: CIRCLECI_CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(CIRCLECI_OAUTH_TIMEOUT_MS),
  }).catch(failed);
  if (response instanceof Error) {
    return {
      kind: "Refused",
      detail: `CircleCI did not answer POST /oauth/register within ${CIRCLECI_OAUTH_TIMEOUT_MS / 1000} s: ${response.message}`,
    };
  }
  const text = await response.text();
  if (!response.ok) {
    return {
      kind: "Refused",
      detail: `CircleCI answered POST /oauth/register with ${response.status}: ${errorText(text)}`,
    };
  }
  const registered = RegisteredSchema.safeParse(parseJson(text));
  if (!registered.success) {
    return {
      kind: "Refused",
      detail: `CircleCI answered POST /oauth/register with ${response.status} and no client_id`,
    };
  }
  return { kind: "Registered", clientId: registered.data.client_id };
};

const TokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });

export type CodeExchange =
  | { kind: "Token"; token: string; expiresInSeconds: number }
  | { kind: "Refused"; detail: string }
  | { kind: "Failed"; detail: string };

export const exchangeCode = async (
  fetcher: Fetch,
  appOrigin: string,
  grant: { code: string; clientId: string; redirectUri: string; verifier: string },
): Promise<CodeExchange> => {
  const response = await fetcher(oauthUrl(appOrigin, "/oauth/token"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "tumpel",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: grant.code,
      client_id: grant.clientId,
      redirect_uri: grant.redirectUri,
      code_verifier: grant.verifier,
    }).toString(),
    signal: AbortSignal.timeout(CIRCLECI_OAUTH_TIMEOUT_MS),
  }).catch(failed);
  if (response instanceof Error) {
    return {
      kind: "Failed",
      detail: `CircleCI did not answer POST /oauth/token within ${CIRCLECI_OAUTH_TIMEOUT_MS / 1000} s: ${response.message}; ${AUTHORIZE_AGAIN}`,
    };
  }
  const text = await response.text();
  if (response.status === 400) {
    return {
      kind: "Refused",
      detail: `CircleCI answered POST /oauth/token with 400: ${errorText(text)}; the code was spent, expired or does not match this authorization's verifier, so ${AUTHORIZE_AGAIN} and paste the address straight away`,
    };
  }
  if (!response.ok) {
    return {
      kind: "Failed",
      detail: `CircleCI answered POST /oauth/token with ${response.status}: ${errorText(text)}; ${AUTHORIZE_AGAIN} once https://status.circleci.com is green`,
    };
  }
  const token = TokenSchema.safeParse(parseJson(text));
  if (!token.success) {
    return {
      kind: "Failed",
      detail: `CircleCI answered POST /oauth/token with ${response.status} and no access_token with expires_in; ${AUTHORIZE_AGAIN}`,
    };
  }
  return { kind: "Token", token: token.data.access_token, expiresInSeconds: token.data.expires_in };
};
