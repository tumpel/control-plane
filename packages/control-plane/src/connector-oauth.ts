import { z } from "zod";
import { base64Url, type Fetch, fromBase64Url, parseJson } from "./github.ts";

export const CALLBACK_PATH = "/connectors/oauth/callback";
export const STATE_PURPOSE = "tumpel-connector-state-v1";
export const TURN_TOKEN_PURPOSE = "tumpel-connector-turn-token-v1";
export const CALLBACK_BUDGET_MS = 600_000;
export const PHASE_TIMEOUT_MS = 10_000;
export const REFRESH_MARGIN_MS = 60_000;

export const StateClaimsSchema = z.object({
  purpose: z.literal("ConnectorAuthorization"),
  tenantId: z.string().min(1),
  connectorId: z.string().min(1),
  connectorAuthorizationId: z.string().min(1),
  principalId: z.string().min(1),
});
export type StateClaims = z.infer<typeof StateClaimsSchema>;

export const BundleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("Refreshable"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("AccessOnly"), accessToken: z.string().min(1), expiresAt: z.number().int().nullable() }),
]);
export type Bundle = z.infer<typeof BundleSchema>;

export type Endpoints = { issuer: string; resource: string; tokenEndpoint: string };

export type Discovered = Endpoints & {
  authorizationEndpoint: string;
  registrationEndpoint: string;
  scopes: string[];
};

export type Failed<K extends string> = { kind: K; detail: string };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const privateIpv4 = (host: string): boolean => {
  const match = IPV4.exec(host);
  if (match === null) return false;
  const [a = 0, b = 0] = match.slice(1).map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const privateIpv6 = (host: string): boolean => {
  if (!host.startsWith("[")) return false;
  const address = host.slice(1, -1).toLowerCase();
  if (address === "::" || address === "::1") return true;
  if (/^f[cd]/.test(address) || /^fe[89ab]/.test(address)) return true;
  const mapped = /^::ffff:(.+)$/.exec(address)?.[1];
  return mapped !== undefined && (privateIpv4(mapped) || mapped.includes(":"));
};

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export const refusedAddress = (raw: string): string | null => {
  const url = URL.parse(raw);
  if (url === null) return `${raw} is not an address`;
  if (url.protocol !== "https:") return `${raw} is not https`;
  if (url.username !== "" || url.password !== "") return `${url.origin} carries user info`;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `${url.origin} is a local address`;
  }
  if (privateIpv4(host) || privateIpv6(host)) {
    return `${url.origin} is a private, loopback or link-local address`;
  }
  return null;
};

type Answer = { ok: true; status: number; body: unknown } | { ok: false; detail: string };

const outbound = async (fetcher: Fetch, url: string, init: RequestInit): Promise<Answer> => {
  const refused = refusedAddress(url);
  if (refused !== null) return { ok: false, detail: `the control plane never calls ${refused}` };
  const response = await fetcher(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(PHASE_TIMEOUT_MS),
    headers: { accept: "application/json", "user-agent": "tumpel", ...init.headers },
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (response instanceof Error) {
    return { ok: false, detail: `${url} did not answer within ${PHASE_TIMEOUT_MS / 1000} s: ${response.message}` };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, detail: `${url} answered a redirect, and the control plane follows none` };
  }
  const text = await response.text();
  return { ok: true, status: response.status, body: parseJson(text) };
};

const ResourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

const ServerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
});

const wellKnown = (base: string, name: string): string[] => {
  const url = new URL(base);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  const root = `${url.origin}/.well-known/${name}`;
  return path === "" ? [root] : [`${root}${path}`, root];
};

const firstDocument = async <T>(
  fetcher: Fetch,
  urls: string[],
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; detail: string }> => {
  const misses: string[] = [];
  for (const url of urls) {
    const answer = await outbound(fetcher, url, { method: "GET" });
    if (!answer.ok) return answer;
    const parsed = schema.safeParse(answer.body);
    if (answer.status === 200 && parsed.success) return { ok: true, value: parsed.data };
    misses.push(`${url} answered ${answer.status}${answer.status === 200 ? " without the metadata fields" : ""}`);
  }
  return { ok: false, detail: misses.join("; ") };
};

const canonical = (raw: string): string => {
  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
};

export const discover = async (
  fetcher: Fetch,
  connectorUrl: string,
): Promise<{ kind: "Discovered"; discovered: Discovered } | Failed<"DiscoveryFailed" | "RegistrationUnsupported">> => {
  const failed = (detail: string) => ({ kind: "DiscoveryFailed", detail }) as const;
  const resource = await firstDocument(
    fetcher,
    wellKnown(connectorUrl, "oauth-protected-resource"),
    ResourceMetadataSchema,
  );
  if (!resource.ok) return failed(`no protected-resource metadata for ${connectorUrl}: ${resource.detail}`);
  const pinned = canonical(resource.value.resource);
  if (!canonical(connectorUrl).startsWith(pinned) || new URL(pinned).origin !== new URL(connectorUrl).origin) {
    return failed(
      `${connectorUrl} names the resource ${resource.value.resource}, which is not the connector's address`,
    );
  }
  const [issuer] = resource.value.authorization_servers;
  if (issuer === undefined) return failed(`${connectorUrl} names no authorization server`);
  const server = await firstDocument(
    fetcher,
    [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")],
    ServerMetadataSchema,
  );
  if (!server.ok) return failed(`no authorization server metadata for ${issuer}: ${server.detail}`);
  const metadata = server.value;
  if (canonical(metadata.issuer) !== canonical(issuer)) {
    return failed(`the authorization server ${issuer} names itself ${metadata.issuer}`);
  }
  if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) {
    return failed(`the authorization server ${issuer} does not advertise PKCE S256`);
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
    const refused = refusedAddress(endpoint);
    if (refused !== null)
      return failed(`the authorization server ${issuer} names an endpoint the control plane never calls: ${refused}`);
  }
  if (metadata.registration_endpoint === undefined) {
    return {
      kind: "RegistrationUnsupported",
      detail: `the authorization server ${issuer} advertises no dynamic client registration`,
    };
  }
  const advertised = resource.value.scopes_supported ?? metadata.scopes_supported ?? [];
  const scopes = (metadata.scopes_supported ?? []).includes("offline_access")
    ? [...new Set([...advertised, "offline_access"])]
    : advertised;
  return {
    kind: "Discovered",
    discovered: {
      issuer: metadata.issuer,
      resource: resource.value.resource,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      registrationEndpoint: metadata.registration_endpoint,
      scopes,
    },
  };
};

const RegistrationSchema = z.object({ client_id: z.string().min(1) });

export const register = async (
  fetcher: Fetch,
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ kind: "Registered"; clientId: string } | Failed<"RegistrationUnsupported">> => {
  const answer = await outbound(fetcher, registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Tumpel",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!answer.ok) return { kind: "RegistrationUnsupported", detail: answer.detail };
  const registered = RegistrationSchema.safeParse(answer.body);
  if (answer.status >= 300 || !registered.success) {
    return {
      kind: "RegistrationUnsupported",
      detail: `${registrationEndpoint} refused to register the control plane as a client, answering ${answer.status}`,
    };
  }
  return { kind: "Registered", clientId: registered.data.client_id };
};

export const authorizeUrl = (
  discovered: Discovered,
  ask: { clientId: string; redirectUri: string; challenge: string; state: string },
): string => {
  const url = new URL(discovered.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", ask.clientId);
  url.searchParams.set("redirect_uri", ask.redirectUri);
  url.searchParams.set("code_challenge", ask.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", ask.state);
  url.searchParams.set("resource", discovered.resource);
  if (discovered.scopes.length > 0) url.searchParams.set("scope", discovered.scopes.join(" "));
  return url.toString();
};

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});

const TokenErrorSchema = z.object({ error: z.string() });

export type TokenAnswer = { kind: "Issued"; bundle: Bundle } | Failed<"Refused" | "Failed" | "InvalidGrant">;

const tokenRequest = async (
  fetcher: Fetch,
  tokenEndpoint: string,
  form: Record<string, string>,
  previousRefresh: string | null,
  now: number,
): Promise<TokenAnswer> => {
  const answer = await outbound(fetcher, tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!answer.ok) return { kind: "Failed", detail: answer.detail };
  const issued = TokenResponseSchema.safeParse(answer.body);
  if (answer.status === 200 && issued.success) {
    const { access_token, refresh_token, expires_in } = issued.data;
    const expiresAt = expires_in === undefined ? null : now + expires_in * 1000;
    const refreshToken = refresh_token ?? previousRefresh;
    return {
      kind: "Issued",
      bundle:
        refreshToken === null
          ? { kind: "AccessOnly", accessToken: access_token, expiresAt }
          : { kind: "Refreshable", accessToken: access_token, refreshToken, expiresAt },
    };
  }
  const error = TokenErrorSchema.safeParse(answer.body);
  const named = error.success ? error.data.error.replace(/[^a-z_]/g, "") : "no OAuth error";
  if (named === "invalid_grant") {
    return { kind: "InvalidGrant", detail: `${tokenEndpoint} answered invalid_grant` };
  }
  return { kind: "Refused", detail: `${tokenEndpoint} answered ${answer.status} with ${named}` };
};

export const exchangeCode = (
  fetcher: Fetch,
  endpoints: Endpoints,
  grant: { clientId: string; code: string; verifier: string; redirectUri: string },
  now: number,
): Promise<TokenAnswer> =>
  tokenRequest(
    fetcher,
    endpoints.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: grant.code,
      code_verifier: grant.verifier,
      redirect_uri: grant.redirectUri,
      client_id: grant.clientId,
      resource: endpoints.resource,
    },
    null,
    now,
  );

export const refreshBundle = (
  fetcher: Fetch,
  endpoints: Endpoints,
  clientId: string,
  refreshToken: string,
  now: number,
): Promise<TokenAnswer> =>
  tokenRequest(
    fetcher,
    endpoints.tokenEndpoint,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: endpoints.resource },
    refreshToken,
    now,
  );

export const needsRefresh = (bundle: Bundle, now: number): boolean =>
  bundle.kind === "Refreshable" && bundle.expiresAt !== null && bundle.expiresAt - now < REFRESH_MARGIN_MS;

export const pkcePair = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
};

const encoder = new TextEncoder();

const turnTokenMac = async (key: CryptoKey, tenantId: string, turnId: string, connectorId: string): Promise<string> =>
  base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${tenantId}/${turnId}/${connectorId}`))),
  );

export const turnToken = async (
  key: CryptoKey,
  tenantId: string,
  turnId: string,
  connectorId: string,
): Promise<string> => `${tenantId}.${await turnTokenMac(key, tenantId, turnId, connectorId)}`;

export const tenantOfTurnToken = (token: string): string | null => {
  const [tenantId, mac, extra] = token.split(".");
  return tenantId && mac && extra === undefined ? tenantId : null;
};

export const turnTokenMatches = async (
  key: CryptoKey,
  token: string,
  turnId: string,
  connectorId: string,
): Promise<boolean> => {
  const [tenantId, mac, extra] = token.split(".");
  const signature = mac === undefined ? null : fromBase64Url(mac);
  if (!tenantId || signature === null || extra !== undefined) return false;
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(`${tenantId}/${turnId}/${connectorId}`));
};

export const singleFlight = <T>(inFlight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> => {
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const started = run().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
};
