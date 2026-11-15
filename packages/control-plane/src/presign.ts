export type PresignMethod = "GET" | "PUT";

export interface Signer {
  presign(method: PresignMethod, storageKey: string, expiresInSeconds: number, now: Date): Promise<string>;
  presignChecked(storageKey: string, sha256Hex: string, expiresInSeconds: number, now: Date): Promise<string>;
  presignCheckedSized(
    storageKey: string,
    sha256Hex: string,
    sizeBytes: number,
    expiresInSeconds: number,
    now: Date,
  ): Promise<string>;
}

export const CHECKSUM_HEADER = "x-amz-checksum-sha256";

export const checksumOf = (sha256Hex: string): string => {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error(`${sha256Hex} is no lower-case hex SHA-256 digest`);
  const bytes = sha256Hex.match(/../g)?.map((pair) => String.fromCharCode(Number.parseInt(pair, 16))) ?? [];
  return btoa(bytes.join(""));
};

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

export interface SignerEnv {
  R2_ACCOUNT_ID?: string;
  R2_STUB_ORIGIN?: string;
}

const MAX_EXPIRY_SECONDS = 604_800;
const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (text: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

const hmac = async (key: ArrayBuffer | Uint8Array<ArrayBuffer>, text: string): Promise<ArrayBuffer> => {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(text));
};

export const encodeRfc3986 = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const amzDate = (now: Date): string =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export const presignUrl = async (
  credentials: SigV4Credentials,
  method: PresignMethod,
  origin: string,
  segments: string[],
  expiresInSeconds: number,
  now: Date,
  signedHeaders: [string, string][] = [],
): Promise<string> => {
  if (expiresInSeconds < 1 || expiresInSeconds > MAX_EXPIRY_SECONDS) {
    throw new Error(`a presigned URL lives 1 to ${MAX_EXPIRY_SECONDS} seconds, not ${expiresInSeconds}`);
  }
  const host = new URL(origin).host;
  const timestamp = amzDate(now);
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${credentials.region}/${credentials.service}/aws4_request`;
  const path = `/${segments.map(encodeRfc3986).join("/")}`;
  const unsorted: [string, string][] = [["host", host], ...signedHeaders];
  const headers = unsorted.sort((left, right) => (left[0] < right[0] ? -1 : 1));
  const headerNames = headers.map(([name]) => name).join(";");
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", headerNames],
  ]
    .map(([name, value]) => `${encodeRfc3986(name ?? "")}=${encodeRfc3986(value ?? "")}`)
    .sort()
    .join("&");
  const canonical = [
    method,
    path,
    query,
    ...headers.map(([name, value]) => `${name}:${value}`),
    "",
    headerNames,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, await sha256(canonical)].join("\n");
  let key: ArrayBuffer = await hmac(new Uint8Array(encoder.encode(`AWS4${credentials.secretAccessKey}`)), day);
  for (const part of [credentials.region, credentials.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `${origin}${path}?${query}&X-Amz-Signature=${signature}`;
};

const r2Signer = (accountId: string, bucket: string, credentials: SigV4Credentials): Signer => {
  const origin = `https://${accountId}.r2.cloudflarestorage.com`;
  const segments = (storageKey: string): string[] => [bucket, ...storageKey.split("/")];
  return {
    presign: (method, storageKey, expiresInSeconds, now) =>
      presignUrl(credentials, method, origin, segments(storageKey), expiresInSeconds, now),
    presignChecked: (storageKey, sha256Hex, expiresInSeconds, now) =>
      presignUrl(credentials, "PUT", origin, segments(storageKey), expiresInSeconds, now, [
        [CHECKSUM_HEADER, checksumOf(sha256Hex)],
      ]),
    presignCheckedSized: (storageKey, sha256Hex, sizeBytes, expiresInSeconds, now) =>
      presignUrl(credentials, "PUT", origin, segments(storageKey), expiresInSeconds, now, [
        ["content-length", String(sizeBytes)],
        [CHECKSUM_HEADER, checksumOf(sha256Hex)],
      ]),
  };
};

const stubSigner = (origin: string, bucket: string): Signer => {
  const stub = (method: PresignMethod, storageKey: string, expiresInSeconds: number, now: Date): string => {
    const path = [bucket, ...storageKey.split("/")].map(encodeRfc3986).join("/");
    const expires = Math.floor(now.getTime() / 1000) + expiresInSeconds;
    return `${origin}/${path}?X-Tumpel-Method=${method}&X-Tumpel-Expires=${expires}`;
  };
  return {
    presign: async (method, storageKey, expiresInSeconds, now) => stub(method, storageKey, expiresInSeconds, now),
    presignChecked: async (storageKey, sha256Hex, expiresInSeconds, now) =>
      `${stub("PUT", storageKey, expiresInSeconds, now)}&X-Tumpel-Checksum=${encodeRfc3986(checksumOf(sha256Hex))}`,
    presignCheckedSized: async (storageKey, sha256Hex, sizeBytes, expiresInSeconds, now) =>
      `${stub("PUT", storageKey, expiresInSeconds, now)}&X-Tumpel-Checksum=${encodeRfc3986(checksumOf(sha256Hex))}&X-Tumpel-Length=${sizeBytes}`,
  };
};

export const signerOf = (
  env: SignerEnv,
  bucket: string,
  accessKeyId: string | undefined,
  secretAccessKey: string | undefined,
): Signer => {
  if (env.R2_STUB_ORIGIN) return stubSigner(env.R2_STUB_ORIGIN, bucket);
  const { R2_ACCOUNT_ID } = env;
  if (!R2_ACCOUNT_ID || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `R2_ACCOUNT_ID and the S3 key pair of bucket ${bucket} must all be set to presign its URLs; npm run deploy puts them on the Worker from the tofu output worker_secrets, as doc/deploy.md describes`,
    );
  }
  return r2Signer(R2_ACCOUNT_ID, bucket, { accessKeyId, secretAccessKey, region: "auto", service: "s3" });
};
