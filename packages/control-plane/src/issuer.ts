import { IssuerJwkSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { fromBase64, generateDataKey, seal, toBase64, unseal } from "./envelope.ts";
import { type KeyStore, keyStoreOf } from "./key-store.ts";

export type IssuerJwk = z.infer<typeof IssuerJwkSchema>;
export type IssuerClaims = Record<string, string>;

export const ISSUER_TOKEN_TTL_SECONDS = 300;
export const ISSUER_KEY_OVERLAP_MS = 86_400_000;

export interface IssuedToken {
  token: string;
  kid: string;
  subject: string;
  audience: string;
  expiresAt: number;
}

export interface IssuerKeyRetirement {
  kid: string;
  retiresAt: number;
}

export interface IssuerRotation {
  kid: string;
  retiring: IssuerKeyRetirement[];
}

export interface Issuer {
  issuer: string;
  signIssuerToken(subject: string, audience: string, claims: IssuerClaims): Promise<IssuedToken>;
  publishedKeys(): Promise<IssuerJwk[]>;
  rotate(): Promise<IssuerRotation>;
}

interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface IssuerDatabase {
  prepare(query: string): Statement;
  batch<T>(statements: Statement[]): Promise<{ results: T[] }[]>;
}

type KeyRow = { kid: string; wrapped_data_key: string; private_key_sealed: string };
type PublishedRow = { public_jwk: string };
type NewKey = { kid: string; publicJwk: string; wrappedDataKey: string; privateKeySealed: string };

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const UNRETIRED = "kid NOT IN (SELECT kid FROM issuer_key_retirements)";
const INSERT_KEY =
  "INSERT INTO issuer_keys (kid, public_jwk, wrapped_data_key, private_key_sealed, created_at) SELECT ?, ?, ?, ?, ?";
const RESEAL =
  "SECRETS_KEK no longer opens the issuer's signing key; restore the key it was sealed with, or run npm run issuer:rotate so a fresh key signs";
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

export const d1Issuer = (db: IssuerDatabase, keyStore: KeyStore, issuer: string, now: () => number): Issuer => {
  const insertKey = (key: NewKey, at: number, clause: string): Statement =>
    db.prepare(`${INSERT_KEY} ${clause}`).bind(key.kid, key.publicJwk, key.wrappedDataKey, key.privateKeySealed, at);

  const currentRow = (): Promise<KeyRow | null> =>
    db
      .prepare(
        `SELECT kid, wrapped_data_key, private_key_sealed FROM issuer_keys WHERE ${UNRETIRED} ORDER BY created_at DESC, kid DESC LIMIT 1`,
      )
      .first<KeyRow>();

  const current = async (): Promise<KeyRow> => {
    const row = await currentRow();
    if (row !== null) return row;
    await insertKey(
      await newKey(keyStore),
      now(),
      `WHERE NOT EXISTS (SELECT 1 FROM issuer_keys WHERE ${UNRETIRED})`,
    ).run();
    const created = await currentRow();
    if (created === null)
      throw new Error("issuer_keys holds no current key right after the insert; check the D1 migrations");
    return created;
  };

  return {
    issuer,
    async signIssuerToken(subject, audience, claims) {
      const row = await current();
      const pkcs8 = await unseal(
        await keyStore.unwrap(row.wrapped_data_key),
        row.private_key_sealed,
        sealContext(row.kid),
        RESEAL,
      );
      const key = await crypto.subtle.importKey("pkcs8", fromBase64(pkcs8), RS256, false, ["sign"]);
      const issuedAt = Math.floor(now() / 1000);
      const expiresAt = issuedAt + ISSUER_TOKEN_TTL_SECONDS;
      const signed = `${base64UrlJson({ alg: "RS256", typ: "JWT", kid: row.kid })}.${base64UrlJson({
        ...claims,
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
    async publishedKeys() {
      await current();
      const { results } = await db
        .prepare(
          `SELECT k.public_jwk FROM issuer_keys k LEFT JOIN issuer_key_retirements r ON r.kid = k.kid
          WHERE r.kid IS NULL OR r.retires_at > ? ORDER BY k.created_at DESC, k.kid DESC`,
        )
        .bind(now())
        .all<PublishedRow>();
      return results.map((row) => IssuerJwkSchema.parse(JSON.parse(row.public_jwk)));
    },
    async rotate() {
      const key = await newKey(keyStore);
      const at = now();
      const retiresAt = at + ISSUER_KEY_OVERLAP_MS;
      const [, , retired] = await db.batch<{ kid: string }>([
        db
          .prepare(
            "DELETE FROM issuer_keys WHERE kid IN (SELECT kid FROM issuer_key_retirements WHERE retires_at <= ?)",
          )
          .bind(at),
        db.prepare("DELETE FROM issuer_key_retirements WHERE retires_at <= ?").bind(at),
        db
          .prepare(
            `INSERT INTO issuer_key_retirements (kid, retires_at) SELECT kid, ? FROM issuer_keys WHERE ${UNRETIRED} RETURNING kid`,
          )
          .bind(retiresAt),
        insertKey(key, at, ""),
      ]);
      if (retired === undefined) throw new Error("D1 answered the issuer rotation without the keys it retired");
      return { kid: key.kid, retiring: retired.results.map((row) => ({ kid: row.kid, retiresAt })) };
    },
  };
};

export interface IssuerEnv {
  DB: IssuerDatabase;
  SECRETS_KEK?: string;
  ISSUER_HOSTNAME: string;
}

export const issuerOf = (env: IssuerEnv): Issuer => {
  if (!env.ISSUER_HOSTNAME) {
    throw new Error(
      "ISSUER_HOSTNAME is not set; npm run deploy sets it from the issuer_hostname output of packages/control-plane/infra",
    );
  }
  return d1Issuer(env.DB, keyStoreOf(env), `https://${env.ISSUER_HOSTNAME}`, Date.now);
};
