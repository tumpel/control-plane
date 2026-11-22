import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { IssuerJwkSchema, type OpenIdConfigurationSchema } from "@tumpel/schemas";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { issuerKeys } from "./db/central-schema.ts";
import { centralDb } from "./db/client.ts";
import { fromBase64, generateDataKey, seal, toBase64, unseal } from "./envelope.ts";
import { type KeyStore, keyStoreOf } from "./key-store.ts";

export type IssuerJwk = z.infer<typeof IssuerJwkSchema>;

export const ISSUER_TOKEN_TTL_SECONDS = 300;
export const OPENID_CONFIGURATION_PATH = "/.well-known/openid-configuration";
export const JWKS_PATH = "/.well-known/jwks.json";
export const ISSUER_DOCUMENT_HEADERS = { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" };

export type IssuerSubject = { ok: true; subject: string } | { ok: false; detail: string };

export const issuerSubject = (tenantId: string, personaName: string): IssuerSubject => {
  const colon = [tenantId, personaName].find((field) => field.includes(":"));
  if (colon !== undefined) {
    return {
      ok: false,
      detail: `${colon} holds a colon, which would let its token subject match another tenant or persona's trust rule`,
    };
  }
  return { ok: true, subject: `tenant:${tenantId}:persona:${personaName}:job:prebuild` };
};

export const openIdConfiguration = (issuer: string): z.infer<typeof OpenIdConfigurationSchema> => ({
  issuer,
  jwks_uri: `${issuer}${JWKS_PATH}`,
  response_types_supported: ["id_token"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  scopes_supported: ["openid"],
  claims_supported: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
});

export interface IssuedToken {
  token: string;
  kid: string;
  subject: string;
  audience: string;
  expiresAt: number;
}

type KeyRow = { kid: string; wrappedDataKey: string; privateKeySealed: string };
type NewKey = { kid: string; publicJwk: string; wrappedDataKey: string; privateKeySealed: string };

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const RESEAL = "SECRETS_KEK no longer opens the issuer's signing key; restore the key it was sealed with";
const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const sealContext = (kid: string): string => `issuer-key/${kid}`;

const base64UrlJson = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)));

const thumbprint = async (n: string, e: string): Promise<string> =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({ e, kty: "RSA", n })))),
  );

const newKey = async (keyStore: KeyStore): Promise<NewKey> => {
  const pair = await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("WebCrypto generated no RSA key pair for the issuer");
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (exported instanceof ArrayBuffer || !(pkcs8 instanceof ArrayBuffer)) {
    throw new Error("WebCrypto exported the issuer key pair in the wrong formats");
  }
  const { n, e } = exported;
  if (typeof n !== "string" || typeof e !== "string") {
    throw new Error("WebCrypto exported the issuer public key without its modulus or exponent");
  }
  const kid = await thumbprint(n, e);
  const jwk: IssuerJwk = { kty: "RSA", use: "sig", alg: "RS256", kid, n, e };
  const dataKey = await generateDataKey();
  return {
    kid,
    publicJwk: JSON.stringify(IssuerJwkSchema.parse(jwk)),
    wrappedDataKey: await keyStore.wrap(dataKey),
    privateKeySealed: await seal(dataKey, toBase64(new Uint8Array(pkcs8)), sealContext(kid)),
  };
};

export const d1Issuer = (d1: D1Database, keyStore: KeyStore, issuer: string, now: () => number) => {
  const db = centralDb(d1);

  const signingRow = async (): Promise<KeyRow | null> =>
    (await db
      .select({
        kid: issuerKeys.kid,
        wrappedDataKey: issuerKeys.wrappedDataKey,
        privateKeySealed: issuerKeys.privateKeySealed,
      })
      .from(issuerKeys)
      .where(eq(issuerKeys.keySlot, 1))
      .get()) ?? null;

  const signing = async (): Promise<KeyRow> => {
    const row = await signingRow();
    if (row !== null) return row;
    const key = await newKey(keyStore);
    await db
      .insert(issuerKeys)
      .values({
        keySlot: 1,
        kid: key.kid,
        publicJwk: key.publicJwk,
        wrappedDataKey: key.wrappedDataKey,
        privateKeySealed: key.privateKeySealed,
      })
      .onConflictDoNothing({ target: issuerKeys.keySlot });
    const created = await signingRow();
    if (created === null)
      throw new Error("issuer_keys holds no signing key right after the insert; check the D1 migrations");
    return created;
  };

  return {
    issuer,
    async signIssuerToken(subject: string, audience: string): Promise<IssuedToken> {
      const at = now();
      const row = await signing();
      const pkcs8 = await unseal(
        await keyStore.unwrap(row.wrappedDataKey),
        row.privateKeySealed,
        sealContext(row.kid),
        RESEAL,
      );
      const key = await crypto.subtle.importKey("pkcs8", fromBase64(pkcs8), RS256, false, ["sign"]);
      const issuedAt = Math.floor(at / 1000);
      const expiresAt = issuedAt + ISSUER_TOKEN_TTL_SECONDS;
      const signed = `${base64UrlJson({ alg: "RS256", typ: "JWT", kid: row.kid })}.${base64UrlJson({
        iss: issuer,
        sub: subject,
        aud: audience,
        iat: issuedAt,
        nbf: issuedAt,
        exp: expiresAt,
        jti: crypto.randomUUID(),
      })}`;
      const signature = await crypto.subtle.sign(RS256, key, encoder.encode(signed));
      return {
        token: `${signed}.${base64Url(new Uint8Array(signature))}`,
        kid: row.kid,
        subject,
        audience,
        expiresAt: expiresAt * 1000,
      };
    },
    async publishedKeys(): Promise<IssuerJwk[]> {
      await signing();
      const published = await db.select({ publicJwk: issuerKeys.publicJwk }).from(issuerKeys);
      return published.map((row) => IssuerJwkSchema.parse(JSON.parse(row.publicJwk)));
    },
  };
};

export interface IssuerEnv {
  DB: D1Database;
  SECRETS_KEK?: string;
  ISSUER_HOSTNAME: string;
}

export const issuerOf = (env: IssuerEnv): ReturnType<typeof d1Issuer> => {
  if (!env.ISSUER_HOSTNAME) {
    throw new Error(
      "ISSUER_HOSTNAME is not set; npm run deploy sets it from the issuer_hostname output of packages/control-plane/infra",
    );
  }
  return d1Issuer(env.DB, keyStoreOf(env), `https://${env.ISSUER_HOSTNAME}`, Date.now);
};
