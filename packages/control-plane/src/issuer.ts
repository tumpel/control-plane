import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types/index.ts";
import { IssuerJwkSchema, type OpenIdConfigurationSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { fromBase64, generateDataKey, seal, toBase64, unseal } from "./envelope.ts";
import { type KeyStore, keyStoreOf } from "./key-store.ts";

export type IssuerJwk = z.infer<typeof IssuerJwkSchema>;

export const ISSUER_TOKEN_TTL_SECONDS = 300;
export const ISSUER_KEY_OVERLAP_MS = 86_400_000;
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

export interface IssuerRotation {
  signingKid: string;
  kid: string;
  signsFrom: number;
}

type KeyRow = { kid: string; wrapped_data_key: string; private_key_sealed: string };
type PendingRow = { kid: string; signs_from: number };
type PublishedRow = { public_jwk: string };
type NewKey = { kid: string; publicJwk: string; wrappedDataKey: string; privateKeySealed: string };

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const SUPERSEDED = "EXISTS (SELECT 1 FROM issuer_keys s WHERE s.signs_from > k.signs_from AND s.signs_from <= ?)";
const INSERT_KEY =
  "INSERT INTO issuer_keys (kid, public_jwk, wrapped_data_key, private_key_sealed, signs_from) SELECT ?, ?, ?, ?, ?";
const RESEAL =
  "SECRETS_KEK no longer opens the issuer's signing key; restore the key it was sealed with, or run npm run issuer:rotate so a fresh key signs 24 h later";
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

export const d1Issuer = (db: D1Database, keyStore: KeyStore, issuer: string, now: () => number) => {
  const insertKey = (key: NewKey, signsFrom: number, clause: string, ...values: number[]): D1PreparedStatement =>
    db
      .prepare(`${INSERT_KEY} ${clause}`)
      .bind(key.kid, key.publicJwk, key.wrappedDataKey, key.privateKeySealed, signsFrom, ...values);

  const signingRow = (at: number): Promise<KeyRow | null> =>
    db
      .prepare(
        "SELECT kid, wrapped_data_key, private_key_sealed FROM issuer_keys WHERE signs_from <= ? ORDER BY signs_from DESC, kid DESC LIMIT 1",
      )
      .bind(at)
      .first<KeyRow>();

  const pendingKey = (at: number): Promise<PendingRow | null> =>
    db
      .prepare("SELECT kid, signs_from FROM issuer_keys WHERE signs_from > ? ORDER BY signs_from ASC, kid ASC LIMIT 1")
      .bind(at)
      .first<PendingRow>();

  const signing = async (at: number): Promise<KeyRow> => {
    const row = await signingRow(at);
    if (row !== null) return row;
    await insertKey(
      await newKey(keyStore),
      at,
      "WHERE NOT EXISTS (SELECT 1 FROM issuer_keys WHERE signs_from <= ?)",
      at,
    ).run();
    const created = await signingRow(at);
    if (created === null)
      throw new Error("issuer_keys holds no signing key right after the insert; check the D1 migrations");
    return created;
  };

  return {
    issuer,
    async signIssuerToken(subject: string, audience: string): Promise<IssuedToken> {
      const at = now();
      const row = await signing(at);
      const pkcs8 = await unseal(
        await keyStore.unwrap(row.wrapped_data_key),
        row.private_key_sealed,
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
      const at = now();
      await signing(at);
      const { results } = await db
        .prepare(
          `SELECT k.public_jwk FROM issuer_keys k WHERE NOT ${SUPERSEDED} ORDER BY k.signs_from DESC, k.kid DESC`,
        )
        .bind(at - ISSUER_KEY_OVERLAP_MS)
        .all<PublishedRow>();
      return results.map((row) => IssuerJwkSchema.parse(JSON.parse(row.public_jwk)));
    },
    async rotate(): Promise<IssuerRotation> {
      const at = now();
      const current = await signing(at);
      const waiting = await pendingKey(at);
      if (waiting !== null) return { signingKid: current.kid, kid: waiting.kid, signsFrom: waiting.signs_from };
      const key = await newKey(keyStore);
      await db.batch([
        db.prepare(`DELETE FROM issuer_keys AS k WHERE ${SUPERSEDED}`).bind(at - ISSUER_KEY_OVERLAP_MS),
        insertKey(
          key,
          at + ISSUER_KEY_OVERLAP_MS,
          "WHERE NOT EXISTS (SELECT 1 FROM issuer_keys WHERE signs_from > ?)",
          at,
        ),
      ]);
      const pending = await pendingKey(at);
      if (pending === null)
        throw new Error("issuer_keys holds no pending key right after the rotation; check the D1 migrations");
      return { signingKid: current.kid, kid: pending.kid, signsFrom: pending.signs_from };
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
