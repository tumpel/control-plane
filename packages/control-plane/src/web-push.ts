const encoder = new TextEncoder();
const ECDH = { name: "ECDH", namedCurve: "P-256" };
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT_BYTES = 3993;

const bytes = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
};

const owned = (value: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
};

const base64Url = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const base64UrlBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
};

const hkdf = async (
  ikm: BufferSource,
  salt: BufferSource,
  info: BufferSource,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
};

export const encryptPushPayload = async (
  plaintext: Uint8Array,
  userAgentPublic: Uint8Array,
  authSecret: Uint8Array,
  salt: Uint8Array,
  applicationServerKeys: CryptoKeyPair,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error(`the Web Push payload is ${plaintext.byteLength} bytes; it must be at most ${MAX_PLAINTEXT_BYTES}`);
  }
  const uaPublic = owned(userAgentPublic);
  const authentication = owned(authSecret);
  const messageSalt = owned(salt);
  const message = owned(plaintext);
  const exportedPublic = await crypto.subtle.exportKey("raw", applicationServerKeys.publicKey);
  if (!(exportedPublic instanceof ArrayBuffer))
    throw new Error("WebCrypto exported the Web Push key in the wrong format");
  const applicationServerPublic = new Uint8Array(exportedPublic);
  const userAgentKey = await crypto.subtle.importKey("raw", uaPublic, ECDH, false, []);
  const agreement = { name: "ECDH", public: userAgentKey };
  const shared = await crypto.subtle.deriveBits(agreement, applicationServerKeys.privateKey, 256);
  const keyInfo = bytes(encoder.encode("WebPush: info"), new Uint8Array([0]), uaPublic, applicationServerPublic);
  const ikm = await hkdf(shared, authentication, keyInfo, 32);
  const cek = await hkdf(ikm, messageSalt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, messageSalt, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, bytes(message, new Uint8Array([2]))),
  );
  const header = new Uint8Array(21 + applicationServerPublic.byteLength);
  header.set(messageSalt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = applicationServerPublic.byteLength;
  header.set(applicationServerPublic, 21);
  return bytes(header, ciphertext);
};

export const encryptedPushPayload = async (
  plaintext: string,
  userAgentPublic: string,
  authSecret: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const salt = new Uint8Array(new ArrayBuffer(16));
  crypto.getRandomValues(salt);
  const generated = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  if (!("privateKey" in generated)) throw new Error("WebCrypto generated no P-256 key pair for Web Push");
  return encryptPushPayload(
    encoder.encode(plaintext),
    base64UrlBytes(userAgentPublic),
    base64UrlBytes(authSecret),
    salt,
    generated,
  );
};

type VapidKey = { privateKey: CryptoKey; publicKey: string };

let loadedVapidKey: { pem: string; key: VapidKey } | undefined;

const privateKeyBytes = (pem: string | undefined): Uint8Array<ArrayBuffer> => {
  const body = pem?.match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/)?.[1];
  if (body === undefined) {
    throw new Error(
      "VAPID_PRIVATE_KEY is not a PKCS#8 PEM private key; deploy must provide the P-256 key from the tofu VAPID resource",
    );
  }
  return Uint8Array.from(atob(body.replaceAll(/\s/g, "")), (char) => char.charCodeAt(0));
};

export const vapidKey = async (pem: string | undefined): Promise<VapidKey> => {
  if (pem !== undefined && loadedVapidKey?.pem === pem) return loadedVapidKey.key;
  const privateKey = await crypto.subtle
    .importKey("pkcs8", privateKeyBytes(pem), ECDSA, true, ["sign"])
    .catch((error: unknown) => {
      throw new Error("VAPID_PRIVATE_KEY does not hold a P-256 private key; replace the tofu VAPID resource", {
        cause: error,
      });
    });
  const exported = await crypto.subtle.exportKey("jwk", privateKey);
  if (exported instanceof ArrayBuffer) throw new Error("WebCrypto exported the VAPID key in the wrong format");
  if (exported.x === undefined || exported.y === undefined) {
    throw new Error("VAPID_PRIVATE_KEY exported without a public key");
  }
  const key = {
    privateKey,
    publicKey: base64Url(bytes(new Uint8Array([4]), base64UrlBytes(exported.x), base64UrlBytes(exported.y))),
  };
  if (pem !== undefined) loadedVapidKey = { pem, key };
  return key;
};

const encodedJson = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)));

export const vapidAuthorization = async (
  endpoint: string,
  subject: string,
  key: VapidKey,
  now: number,
): Promise<string> => {
  const header = encodedJson({ typ: "JWT", alg: "ES256" });
  const claims = encodedJson({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 24 * 60 * 60,
    sub: subject,
  });
  const unsigned = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${base64Url(signature)}, k=${key.publicKey}`;
};

export const pushRequest = async (
  endpoint: string,
  payload: string,
  userAgentPublic: string,
  authSecret: string,
  vapidPrivateKey: string | undefined,
  subject: string,
  now: number,
): Promise<Request> => {
  const key = await vapidKey(vapidPrivateKey);
  return new Request(endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(endpoint, subject, key, now),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
    },
    body: await encryptedPushPayload(payload, userAgentPublic, authSecret),
    signal: AbortSignal.timeout(10_000),
  });
};
