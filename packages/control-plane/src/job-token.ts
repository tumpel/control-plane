import { z } from "zod";

export type JobTokenCheck = "token" | "iss" | "kid" | "signature" | "aud" | "exp";

export type VerifiedJobToken =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; check: JobTokenCheck; detail: string };

const CLOCK_LEEWAY_SECONDS = 60;
const KEYS_TTL_MS = 3_600_000;
const REFRESH_FLOOR_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

const DiscoverySchema = z.object({ issuer: z.string(), jwks_uri: z.url() });

const RsaJwkSchema = z.object({ kty: z.literal("RSA"), kid: z.string(), n: z.string(), e: z.string() });
const EcJwkSchema = z.object({
  kty: z.literal("EC"),
  kid: z.string(),
  crv: z.literal("P-256"),
  x: z.string(),
  y: z.string(),
});
const JwkSchema = z.discriminatedUnion("kty", [RsaJwkSchema, EcJwkSchema]);
const JwksSchema = z.object({ keys: z.array(z.unknown()) });

const HeaderSchema = z.object({ alg: z.enum(["RS256", "ES256"]), kid: z.string() });
const ClaimsSchema = z.looseObject({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
});

type Jwk = z.infer<typeof JwkSchema>;
type Algorithm = z.infer<typeof HeaderSchema>["alg"];

const ALGORITHMS = {
  RS256: {
    kty: "RSA",
    verify: { name: "RSASSA-PKCS1-v1_5" },
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  },
  ES256: {
    kty: "EC",
    verify: { name: "ECDSA", hash: "SHA-256" },
    import: { name: "ECDSA", namedCurve: "P-256" },
  },
} as const satisfies Record<Algorithm, { kty: Jwk["kty"]; verify: object; import: object }>;

const cache = new Map<string, { keys: Map<string, Jwk>; loadedAt: number }>();

const fetchJson = async (url: string, what: string): Promise<unknown> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(
      `the ${what} at ${url} answered ${response.status}; a build job token cannot be checked until it answers`,
    );
  }
  return response.json();
};

const loadKeys = async (issuer: string): Promise<Map<string, Jwk>> => {
  const discovery = DiscoverySchema.parse(
    await fetchJson(`${issuer}/.well-known/openid-configuration`, "OIDC discovery document"),
  );
  if (discovery.issuer !== issuer) {
    throw new Error(
      `the discovery document of ${issuer} names the issuer ${discovery.issuer}; set buildProviderIssuers in TUMPEL_SETTINGS to the issuer the provider publishes`,
    );
  }
  const { keys } = JwksSchema.parse(await fetchJson(discovery.jwks_uri, "JWKS"));
  const parsed = keys.flatMap((key) => {
    const jwk = JwkSchema.safeParse(key);
    return jwk.success ? [[jwk.data.kid, jwk.data] as const] : [];
  });
  const loaded = new Map(parsed);
  cache.set(issuer, { keys: loaded, loadedAt: Date.now() });
  return loaded;
};

const keyOf = async (issuer: string, kid: string): Promise<Jwk | null> => {
  const held = cache.get(issuer);
  const fresh = held !== undefined && Date.now() - held.loadedAt < KEYS_TTL_MS;
  const keys = fresh ? held.keys : await loadKeys(issuer);
  const key = keys.get(kid);
  if (key !== undefined) return key;
  const loadedAt = cache.get(issuer)?.loadedAt ?? 0;
  if (Date.now() - loadedAt < REFRESH_FLOOR_MS) return null;
  return (await loadKeys(issuer)).get(kid) ?? null;
};

const decodeBase64Url = (segment: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) return null;
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
};

const decodeJson = (segment: string): unknown => {
  const bytes = decodeBase64Url(segment);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const refuse = (check: JobTokenCheck, detail: string): VerifiedJobToken => ({ ok: false, check, detail });

export const verifyJobToken = async (
  token: string,
  issuer: string,
  audience: string,
  now: number,
): Promise<VerifiedJobToken> => {
  const [headerSegment, payloadSegment, signatureSegment, ...extra] = token.split(".");
  if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined || extra.length) {
    return refuse("token", "the bearer token is not a JWT");
  }
  const header = HeaderSchema.safeParse(decodeJson(headerSegment));
  if (!header.success) return refuse("token", "the JWT header names no kid or an algorithm other than RS256 and ES256");
  const claims = ClaimsSchema.safeParse(decodeJson(payloadSegment));
  if (!claims.success) return refuse("token", "the JWT carries no iss, aud and exp claims");
  const signature = decodeBase64Url(signatureSegment);
  if (signature === null) return refuse("token", "the JWT signature is not base64url");
  if (claims.data.iss !== issuer) {
    return refuse(
      "iss",
      `the token was issued by ${claims.data.iss}, and this prebuild's provider issues from ${issuer}`,
    );
  }
  const jwk = await keyOf(issuer, header.data.kid);
  if (jwk === null) return refuse("kid", `${issuer} publishes no key ${header.data.kid}`);
  const algorithm = ALGORITHMS[header.data.alg];
  if (jwk.kty !== algorithm.kty) {
    return refuse(
      "signature",
      `the token is signed ${header.data.alg} with key ${jwk.kid}, which is an ${jwk.kty} key`,
    );
  }
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm.import, false, ["verify"]);
  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  if (!(await crypto.subtle.verify(algorithm.verify, key, signature, signed))) {
    return refuse("signature", `the token's signature does not verify against key ${jwk.kid} of ${issuer}`);
  }
  const audiences = typeof claims.data.aud === "string" ? [claims.data.aud] : claims.data.aud;
  if (!audiences.includes(audience)) {
    return refuse("aud", `the token is meant for ${audiences.join(", ")}, and this API takes only ${audience}`);
  }
  if (claims.data.exp + CLOCK_LEEWAY_SECONDS <= now / 1000) {
    return refuse("exp", `the token expired at ${new Date(claims.data.exp * 1000).toISOString()}`);
  }
  return { ok: true, claims: claims.data };
};
