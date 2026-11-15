const IV_BYTES = 12;
const KEY_BYTES = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

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

const RESEAL_SECRET_SET = "write the secret set again with tumpel config apply --rewrite-secrets";

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
