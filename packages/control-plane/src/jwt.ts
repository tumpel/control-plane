export type JwtCheck = "token" | "keys" | "kid" | "signature" | "iss" | "aud" | "exp" | "nbf";

export type VerifiedJwt =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; check: JwtCheck; detail: string };

export type VerifyJwt = (token: string) => Promise<VerifiedJwt>;

const KEY_TTL_MS = 3_600_000;
const REFRESH_FLOOR_MS = 60_000;
const CLOCK_LEEWAY_S = 60;
const FETCH_TIMEOUT_MS = 5_000;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

interface KeySource {
  keys(): Promise<Map<string, CryptoKey> | null>;
  refresh(): Promise<Map<string, CryptoKey> | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJwk = (value: unknown): value is Jwk =>
  isRecord(value) &&
  typeof value.kid === "string" &&
  value.kty === "RSA" &&
  typeof value.n === "string" &&
  typeof value.e === "string";

const parseKeySet = (keysUrl: string, text: string): Jwk[] => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    throw new Error(`the signing keys at ${keysUrl} hold no keys array`);
  }
  return parsed.keys.filter(isJwk);
};

const importKeys = async (jwks: Jwk[]): Promise<Map<string, CryptoKey>> =>
  new Map(
    await Promise.all(
      jwks.map(
        async (jwk): Promise<[string, CryptoKey]> => [
          jwk.kid,
          await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" }, RS256, false, [
            "verify",
          ]),
        ],
      ),
    ),
  );

const cachedKeys = (keysUrl: string): KeySource => {
  let current: { keys: Map<string, CryptoKey>; loadedAt: number } | null = null;

  const fromOrigin = async (): Promise<Jwk[] | null> => {
    const response = await fetch(keysUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `the signing keys at ${keysUrl} answered ${response.status}; no token can be checked until it answers`,
      );
    }
    return parseKeySet(keysUrl, await response.text());
  };

  const load = async (jwks: Jwk[] | null): Promise<Map<string, CryptoKey> | null> => {
    if (jwks === null) return null;
    const keys = await importKeys(jwks);
    current = { keys, loadedAt: Date.now() };
    return keys;
  };

  return {
    async keys() {
      if (current && Date.now() - current.loadedAt < KEY_TTL_MS) return current.keys;
      return load(await fromOrigin());
    },
    async refresh() {
      if (current && Date.now() - current.loadedAt < REFRESH_FLOOR_MS) return null;
      return load(await fromOrigin());
    },
  };
};

const decodeBase64Url = (segment: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) return null;
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
};

const decodeJson = (segment: string): Record<string, unknown> | null => {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const refuse = (check: JwtCheck, detail: string): VerifiedJwt => ({ ok: false, check, detail });

export const jwtVerifier = (keysUrl: string, issuer: string, audience: string): VerifyJwt => {
  const source = cachedKeys(keysUrl);
  return async (token) => {
    const [headerSegment, payloadSegment, signatureSegment, ...extra] = token.split(".");
    if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined || extra.length) {
      return refuse("token", "the token is not a JWT");
    }
    const header = decodeJson(headerSegment);
    const claims = decodeJson(payloadSegment);
    const signature = decodeBase64Url(signatureSegment);
    if (!header || !claims || !signature) return refuse("token", "the JWT is malformed");
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      return refuse("token", "the JWT names no kid or is not signed with RS256");
    }
    const keys = await source.keys();
    if (keys === null) return refuse("keys", `the signing keys at ${keysUrl} answered 404`);
    const key = keys.get(header.kid) ?? (await source.refresh())?.get(header.kid) ?? null;
    if (!key) return refuse("kid", `the signing keys at ${keysUrl} hold no key ${header.kid}`);
    const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
    if (!(await crypto.subtle.verify(RS256, key, signature, signed))) {
      return refuse("signature", `the JWT signature does not verify against key ${header.kid}`);
    }
    if (claims.iss !== issuer) return refuse("iss", `the JWT was issued by ${String(claims.iss)}, not ${issuer}`);
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!audiences.includes(audience)) {
      return refuse("aud", `the JWT is meant for ${audiences.join(", ") || "no audience"}, not ${audience}`);
    }
    const nowS = Date.now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_LEEWAY_S <= nowS) {
      return refuse("exp", "the JWT has expired or carries no exp");
    }
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_LEEWAY_S > nowS) {
      return refuse("nbf", "the JWT is not valid yet");
    }
    return { ok: true, claims };
  };
};

export const unverifiedIssuer = (token: string): string | null => {
  const claims = decodeJson(token.split(".")[1] ?? "");
  return typeof claims?.iss === "string" ? claims.iss : null;
};
