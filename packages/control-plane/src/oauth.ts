import { MCP_PATH } from "@tumpel/api/constants";
import {
  AuthorizationServerMetadataSchema,
  OAuthClientSchema,
  OAuthGrantSchema,
  OAuthTokenSchema,
  ProtectedResourceMetadataSchema,
} from "@tumpel/api/schemas";
import { z } from "zod";
import { base64Url, randomToken, sameSecret, sha256Hex } from "./crypto";
import type { OAuthErrorCode } from "./http";
import type { Caller, Role } from "./identity";

export { MCP_PATH };

export const AUTHORIZE_PATH = "/oauth/authorize";
export const CONSENT_PATH = "/oauth/consent";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const REVOKE_PATH = "/oauth/revoke";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
export const SCOPE = "tumpel";
export const CONNECTOR_ORIGINS = ["https://claude.ai", "https://chatgpt.com", "https://chat.mistral.ai"];

const REQUEST_TTL_MS = 600_000;
const CODE_TTL_MS = 120_000;
const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 2_592_000_000;
const CLIENT_TTL_MS = 3_600_000;
const CLIENT_NAME_LIMIT = 100;
const STATE_LIMIT = 512;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type OAuthClient = z.infer<typeof OAuthClientSchema>;
type OAuthToken = z.infer<typeof OAuthTokenSchema>;
type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

export const resourceOf = (origin: string): string => `${origin}${MCP_PATH}`;

export const resourceMetadataUrl = (origin: string): string => `${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}`;

export const protectedResourceMetadata = (origin: string): unknown =>
  ProtectedResourceMetadataSchema.parse({
    resource: resourceOf(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "tumpel",
  });

export const authorizationServerMetadata = (origin: string): unknown =>
  AuthorizationServerMetadataSchema.parse({
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
  });

export interface AuthorizationRequest {
  requestId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  firstParty: boolean;
}

export type Refusal = { error: OAuthErrorCode; description: string };

export type TokenOutcome = { ok: true; token: OAuthToken } | ({ ok: false } & Refusal);

const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const usableRedirect = (value: string): boolean => {
  const url = parsedUrl(value);
  return url !== null && url.protocol === "https:" && url.hash === "" && url.username === "" && url.password === "";
};

export const clientName = (name: string | undefined): string =>
  name !== undefined && name.trim() !== "" ? name.trim().slice(0, CLIENT_NAME_LIMIT) : "an MCP client";

export const registerClient = async (
  db: D1Database,
  name: string,
  redirectUris: string[],
  now: number,
): Promise<OAuthClient> => {
  const clientId = randomToken();
  await db.batch([
    db
      .prepare(
        `DELETE FROM oauth_clients WHERE created_at <= ?
          AND first_party = 0
          AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.client_id AND t.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = oauth_clients.client_id AND r.expires_at > ?)`,
      )
      .bind(now - CLIENT_TTL_MS, now, now),
    db
      .prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
      .bind(clientId, name, JSON.stringify(redirectUris), now),
  ]);
  return OAuthClientSchema.parse({
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  });
};

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export const clientFor = async (db: D1Database, clientId: string): Promise<RegisteredClient | null> => {
  const row = await db
    .prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<{ client_id: string; client_name: string; redirect_uris: string }>();
  if (row === null) return null;
  const parsed: unknown = JSON.parse(row.redirect_uris);
  const redirectUris = Array.isArray(parsed) ? parsed.filter((uri): uri is string => typeof uri === "string") : [];
  return { clientId: row.client_id, clientName: row.client_name, redirectUris };
};

export interface AuthorizeAsk {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  resources: string[];
}

export const readAuthorizeAsk = (url: URL): AuthorizeAsk => {
  const one = (name: string): string => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? (values[0] ?? "") : "";
  };
  const states = url.searchParams.getAll("state");
  return {
    responseType: one("response_type"),
    clientId: one("client_id"),
    redirectUri: one("redirect_uri"),
    state: states.length === 1 ? (states[0] ?? null) : null,
    codeChallenge: one("code_challenge"),
    codeChallengeMethod: one("code_challenge_method"),
    resources: url.searchParams.getAll("resource"),
  };
};

const resourceMismatch = (resources: string[], origin: string): boolean =>
  resources.some((resource) => resource !== resourceOf(origin) && resource !== origin);

export const redirectFor = (ask: AuthorizeAsk, client: RegisteredClient): string | null => {
  if (ask.redirectUri === "") return client.redirectUris.length === 1 ? (client.redirectUris[0] ?? null) : null;
  return client.redirectUris.includes(ask.redirectUri) ? ask.redirectUri : null;
};

export const askRefusal = (ask: AuthorizeAsk, origin: string): Refusal | null => {
  if (ask.responseType !== "code") {
    return { error: "unsupported_response_type", description: "response_type must be code" };
  }
  if (ask.codeChallengeMethod !== "S256") {
    return { error: "invalid_request", description: "code_challenge_method must be S256" };
  }
  if (!CHALLENGE_PATTERN.test(ask.codeChallenge)) {
    return { error: "invalid_request", description: "code_challenge must be a base64url SHA-256 digest" };
  }
  if (ask.state !== null && ask.state.length > STATE_LIMIT) {
    return { error: "invalid_request", description: `state holds at most ${STATE_LIMIT} characters` };
  }
  if (resourceMismatch(ask.resources, origin)) {
    return { error: "invalid_target", description: `resource must be ${resourceOf(origin)}` };
  }
  return null;
};

export const redirectBack = (
  redirectUri: string,
  state: string | null,
  origin: string,
  answer: Record<string, string>,
): string => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(answer)) url.searchParams.set(name, value);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", origin);
  return url.toString();
};

export const startAuthorization = async (
  db: D1Database,
  ask: AuthorizeAsk,
  redirectUri: string,
  now: number,
): Promise<string> => {
  const requestId = randomToken();
  await db.batch([
    db.prepare("DELETE FROM oauth_requests WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        `INSERT INTO oauth_requests (request_id, client_id, redirect_uri, state, state_sent, code_challenge, created_at,
          expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        requestId,
        ask.clientId,
        redirectUri,
        ask.state ?? "",
        ask.state === null ? 0 : 1,
        ask.codeChallenge,
        now,
        now + REQUEST_TTL_MS,
      ),
  ]);
  return requestId;
};

export const pendingAuthorization = async (
  db: D1Database,
  requestId: string,
  now: number,
): Promise<AuthorizationRequest | null> => {
  const row = await db
    .prepare(
      `SELECT r.request_id, r.client_id, c.client_name, c.first_party, r.redirect_uri, r.state, r.state_sent,
        r.code_challenge
      FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id
      WHERE r.request_id = ? AND r.expires_at > ?`,
    )
    .bind(requestId, now)
    .first<{
      request_id: string;
      client_id: string;
      client_name: string;
      first_party: number;
      redirect_uri: string;
      state: string;
      state_sent: number;
      code_challenge: string;
    }>();
  if (row === null) return null;
  return {
    requestId: row.request_id,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    state: row.state_sent === 0 ? null : row.state,
    codeChallenge: row.code_challenge,
    firstParty: row.first_party === 1,
  };
};

export const forgetAuthorization = async (db: D1Database, requestId: string): Promise<void> => {
  await db.prepare("DELETE FROM oauth_requests WHERE request_id = ?").bind(requestId).run();
};

export const grantCode = async (
  db: D1Database,
  request: AuthorizationRequest,
  caller: Caller,
  now: number,
): Promise<string> => {
  const code = randomToken();
  await db.batch([
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        `INSERT INTO oauth_codes (code_sha256, client_id, tenant_id, principal_id, redirect_uri, code_challenge,
          created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256Hex(code),
        request.clientId,
        caller.tenantId,
        caller.principalId,
        request.redirectUri,
        request.codeChallenge,
        now,
        now + CODE_TTL_MS,
      ),
    db.prepare("DELETE FROM oauth_requests WHERE request_id = ?").bind(request.requestId),
  ]);
  return code;
};

const pkceMatches = async (verifier: string, challenge: string): Promise<boolean> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return sameSecret(base64Url(digest), challenge);
};

interface Grant {
  grantId: string;
  clientId: string;
  tenantId: string;
  principalId: string;
}

const issue = async (db: D1Database, grant: Grant, now: number): Promise<OAuthToken> => {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const insert = `INSERT INTO oauth_tokens (token_sha256, grant_id, client_id, tenant_id, principal_id, kind, created_at,
    expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const row = async (token: string, kind: string, ttl: number) =>
    db
      .prepare(insert)
      .bind(
        await sha256Hex(token),
        grant.grantId,
        grant.clientId,
        grant.tenantId,
        grant.principalId,
        kind,
        now,
        now + ttl,
      );
  await db.batch([
    db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").bind(now),
    await row(accessToken, "access", ACCESS_TTL_MS),
    await row(refreshToken, "refresh", REFRESH_TTL_MS),
  ]);
  return OAuthTokenSchema.parse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
};

const revokeGrant = async (db: D1Database, grantId: string): Promise<void> => {
  await db.prepare("DELETE FROM oauth_tokens WHERE grant_id = ?").bind(grantId).run();
};

const refuseGrant = (error: OAuthErrorCode, description: string): TokenOutcome => ({ ok: false, error, description });

export interface CodeRedemption {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resources: string[];
}

export const redeemCode = async (
  db: D1Database,
  redemption: CodeRedemption,
  origin: string,
  now: number,
): Promise<TokenOutcome> => {
  if (!VERIFIER_PATTERN.test(redemption.codeVerifier)) {
    return refuseGrant("invalid_request", "code_verifier must hold 43 to 128 unreserved characters");
  }
  if (resourceMismatch(redemption.resources, origin)) {
    return refuseGrant("invalid_target", `resource must be ${resourceOf(origin)}`);
  }
  const codeHash = await sha256Hex(redemption.code);
  const spent = await db
    .prepare(
      "UPDATE oauth_codes SET spent = 1 WHERE code_sha256 = ? AND spent = 0 RETURNING client_id, tenant_id, principal_id, redirect_uri, code_challenge, expires_at",
    )
    .bind(codeHash)
    .first<{
      client_id: string;
      tenant_id: string;
      principal_id: string;
      redirect_uri: string;
      code_challenge: string;
      expires_at: number;
    }>();
  if (spent === null) {
    await revokeGrant(db, codeHash);
    return refuseGrant("invalid_grant", "the authorization code is unknown or already used");
  }
  if (spent.expires_at <= now) return refuseGrant("invalid_grant", "the authorization code expired");
  if (spent.client_id !== redemption.clientId) {
    return refuseGrant("invalid_grant", "the authorization code was issued to another client");
  }
  if (redemption.redirectUri !== spent.redirect_uri) {
    return refuseGrant("invalid_grant", "redirect_uri does not match the one the authorization carried");
  }
  if (!(await pkceMatches(redemption.codeVerifier, spent.code_challenge))) {
    return refuseGrant("invalid_grant", "code_verifier does not match the code_challenge");
  }
  const grant = {
    grantId: codeHash,
    clientId: spent.client_id,
    tenantId: spent.tenant_id,
    principalId: spent.principal_id,
  };
  return { ok: true, token: await issue(db, grant, now) };
};

export const refreshGrant = async (
  db: D1Database,
  refreshToken: string,
  clientId: string,
  origin: string,
  resources: string[],
  now: number,
): Promise<TokenOutcome> => {
  if (resourceMismatch(resources, origin)) {
    return refuseGrant("invalid_target", `resource must be ${resourceOf(origin)}`);
  }
  const refreshHash = await sha256Hex(refreshToken);
  const spent = await db
    .prepare(
      "UPDATE oauth_tokens SET spent = 1 WHERE token_sha256 = ? AND kind = 'refresh' AND spent = 0 RETURNING grant_id, client_id, tenant_id, principal_id, expires_at",
    )
    .bind(refreshHash)
    .first<{ grant_id: string; client_id: string; tenant_id: string; principal_id: string; expires_at: number }>();
  if (spent === null) {
    const reused = await db
      .prepare("SELECT grant_id FROM oauth_tokens WHERE token_sha256 = ? AND kind = 'refresh' AND spent = 1")
      .bind(refreshHash)
      .first<{ grant_id: string }>();
    if (reused !== null) await revokeGrant(db, reused.grant_id);
    return refuseGrant("invalid_grant", "the refresh token is unknown or already used");
  }
  if (spent.expires_at <= now) return refuseGrant("invalid_grant", "the refresh token expired");
  if (spent.client_id !== clientId) return refuseGrant("invalid_grant", "the refresh token belongs to another client");
  const grant = {
    grantId: spent.grant_id,
    clientId: spent.client_id,
    tenantId: spent.tenant_id,
    principalId: spent.principal_id,
  };
  return { ok: true, token: await issue(db, grant, now) };
};

export const revokeToken = async (db: D1Database, token: string, clientId: string): Promise<Refusal | null> => {
  const row = await db
    .prepare("SELECT grant_id, client_id FROM oauth_tokens WHERE token_sha256 = ?")
    .bind(await sha256Hex(token))
    .first<{ grant_id: string; client_id: string }>();
  if (row === null) return null;
  if (row.client_id !== clientId) {
    return { error: "invalid_client", description: "the token was issued to another client" };
  }
  await revokeGrant(db, row.grant_id);
  return null;
};

export const callerForAccessToken = async (db: D1Database, token: string, now: number): Promise<Caller | null> => {
  const row = await db
    .prepare(
      `SELECT m.tenant_id, m.principal_id, m.role FROM oauth_tokens t
      JOIN memberships m ON m.tenant_id = t.tenant_id AND m.principal_id = t.principal_id
      WHERE t.token_sha256 = ? AND t.kind = 'access' AND t.expires_at > ?`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ tenant_id: string; principal_id: string; role: Role }>();
  return row === null ? null : { tenantId: row.tenant_id, principalId: row.principal_id, role: row.role };
};

const RegisteredRedirects = z.tuple([z.url()], z.url());

export const listGrants = async (db: D1Database, caller: Caller, now: number): Promise<OAuthGrant[]> => {
  const rows = await db
    .prepare(
      `SELECT t.grant_id, c.client_id, c.client_name, c.redirect_uris, MAX(t.created_at) AS last_issued_at
      FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.tenant_id = ? AND t.principal_id = ? AND t.spent = 0 AND t.expires_at > ?
      GROUP BY t.grant_id, c.client_id ORDER BY last_issued_at DESC`,
    )
    .bind(caller.tenantId, caller.principalId, now)
    .all<{ grant_id: string; client_id: string; client_name: string; redirect_uris: string; last_issued_at: number }>();
  return rows.results.map((row) => {
    const [first] = RegisteredRedirects.parse(JSON.parse(row.redirect_uris));
    return OAuthGrantSchema.parse({
      grantId: row.grant_id,
      clientId: row.client_id,
      clientName: row.client_name,
      redirectOrigin: new URL(first).origin,
      lastIssuedAt: row.last_issued_at,
    });
  });
};

export const revokeCallerGrant = async (db: D1Database, caller: Caller, grantId: string): Promise<boolean> => {
  const revoked = await db
    .prepare("DELETE FROM oauth_tokens WHERE grant_id = ? AND tenant_id = ? AND principal_id = ? RETURNING grant_id")
    .bind(grantId, caller.tenantId, caller.principalId)
    .all();
  return revoked.results.length > 0;
};
