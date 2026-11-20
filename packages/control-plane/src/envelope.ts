const IV_BYTES = 12;
const KEY_BYTES = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const joined = (iv: Uint8Array, body: ArrayBuffer): string => {
  const bytes = new Uint8Array(iv.byteLength + body.byteLength);
  bytes.set(iv, 0);
  bytes.set(new Uint8Array(body), iv.byteLength);
  return toBase64(bytes);
};

const split = (sealed: string): { iv: Uint8Array<ArrayBuffer>; body: Uint8Array<ArrayBuffer> } => {
  const bytes = fromBase64(sealed);
  return { iv: bytes.slice(0, IV_BYTES), body: bytes.slice(IV_BYTES) };
};

const freshIv = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(IV_BYTES));

const keyBytes = (base64: string | undefined): Uint8Array<ArrayBuffer> => {
  const bytes = base64 === undefined || base64 === "" ? new Uint8Array() : fromBase64(base64);
  if (bytes.byteLength !== KEY_BYTES) {
    throw new Error(
      "SECRETS_KEK is not 32 bytes of base64; the Worker secret comes from the worker_secrets output of packages/control-plane/infra, which npm run deploy sets",
    );
  }
  return bytes;
};

export const importKeyEncryptionKey = async (base64: string | undefined): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", keyBytes(base64), { name: "AES-GCM" }, false, ["wrapKey", "unwrapKey"]);

export const deriveSigningKey = async (base64: string | undefined, purpose: string): Promise<CryptoKey> => {
  const root = await crypto.subtle.importKey("raw", keyBytes(base64), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(purpose) },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
};

const ED25519_PKCS8_PREFIX = Uint8Array.from([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);

export const deriveEd25519KeyPair = async (
  base64: string | undefined,
  purpose: string,
): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array<ArrayBuffer> }> => {
  const root = await crypto.subtle.importKey("raw", keyBytes(base64), "HKDF", false, ["deriveBits"]);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(purpose) },
      root,
      256,
    ),
  );
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.byteLength + seed.byteLength);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.byteLength);
  const readable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const exported = await crypto.subtle.exportKey("jwk", readable);
  if (!("x" in exported) || typeof exported.x !== "string") {
    throw new Error(`the Ed25519 key for ${purpose} exported without its public half`);
  }
  const base64Public = exported.x.replaceAll("-", "+").replaceAll("_", "/");
  const publicKey = Uint8Array.from(atob(base64Public + "=".repeat((4 - (base64Public.length % 4)) % 4)), (char) =>
    char.charCodeAt(0),
  );
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, publicKey };
};

export const generateDataKey = (): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(KEY_BYTES)), { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);

export const wrapDataKey = async (keyEncryptionKey: CryptoKey, dataKey: CryptoKey): Promise<string> => {
  const iv = freshIv();
  return joined(iv, await crypto.subtle.wrapKey("raw", dataKey, keyEncryptionKey, { name: "AES-GCM", iv }));
};

export const newDataKey = async (keyEncryptionKey: CryptoKey): Promise<string> =>
  wrapDataKey(keyEncryptionKey, await generateDataKey());

export const unwrapDataKey = (keyEncryptionKey: CryptoKey, wrapped: string): Promise<CryptoKey> => {
  const { iv, body } = split(wrapped);
  return crypto.subtle
    .unwrapKey("raw", body, keyEncryptionKey, { name: "AES-GCM", iv }, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ])
    .catch((error: unknown) => {
      throw new Error(
        "the tenant's data key does not unwrap with SECRETS_KEK; the Worker secret was replaced, so restore the key it was wrapped with",
        { cause: error },
      );
    });
};

export const seal = async (dataKey: CryptoKey, plaintext: string, context: string): Promise<string> => {
  const iv = freshIv();
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    dataKey,
    encoder.encode(plaintext),
  );
  return joined(iv, body);
};

const RESEAL_SECRET_SET = "write the secret set again";

export const unseal = async (
  dataKey: CryptoKey,
  sealed: string,
  context: string,
  fix: string = RESEAL_SECRET_SET,
): Promise<string> => {
  const { iv, body } = split(sealed);
  const plaintext = await crypto.subtle
    .decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, dataKey, body)
    .catch((error: unknown) => {
      throw new Error(`secret ${context} does not decrypt with its data key; ${fix}`, { cause: error });
    });
  return decoder.decode(plaintext);
};
