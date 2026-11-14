export type PresignMethod = "GET" | "PUT";

export interface Signer {
  presign(method: PresignMethod, storageKey: string, expiresInSeconds: number, now: Date): Promise<string>;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

export interface SignerEnv {
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
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
): Promise<string> => {
  if (expiresInSeconds < 1 || expiresInSeconds > MAX_EXPIRY_SECONDS) {
    throw new Error(`a presigned URL lives 1 to ${MAX_EXPIRY_SECONDS} seconds, not ${expiresInSeconds}`);
  }
  const host = new URL(origin).host;
  const timestamp = amzDate(now);
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${credentials.region}/${credentials.service}/aws4_request`;
  const path = `/${segments.map(encodeRfc3986).join("/")}`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ]
    .map(([name, value]) => `${encodeRfc3986(name ?? "")}=${encodeRfc3986(value ?? "")}`)
    .sort()
    .join("&");
  const canonical = [method, path, query, `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, await sha256(canonical)].join("\n");
  let key: ArrayBuffer = await hmac(new Uint8Array(encoder.encode(`AWS4${credentials.secretAccessKey}`)), day);
  for (const part of [credentials.region, credentials.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `${origin}${path}?${query}&X-Amz-Signature=${signature}`;
};

const r2Signer = (accountId: string, bucket: string, credentials: SigV4Credentials): Signer => ({
  presign: (method, storageKey, expiresInSeconds, now) =>
    presignUrl(
      credentials,
      method,
      `https://${accountId}.r2.cloudflarestorage.com`,
      [bucket, ...storageKey.split("/")],
      expiresInSeconds,
      now,
    ),
});

const stubSigner = (origin: string, bucket: string): Signer => ({
  presign: async (method, storageKey, expiresInSeconds, now) => {
    const path = [bucket, ...storageKey.split("/")].map(encodeRfc3986).join("/");
    const expires = Math.floor(now.getTime() / 1000) + expiresInSeconds;
    return `${origin}/${path}?X-Tumpel-Method=${method}&X-Tumpel-Expires=${expires}`;
  },
});

export const signerOf = (env: SignerEnv): Signer => {
  if (env.R2_STUB_ORIGIN) return stubSigner(env.R2_STUB_ORIGIN, env.R2_BUCKET_NAME);
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set to presign snapshot URLs; put the R2 S3 API key pair with wrangler secret put as doc/deploy.md describes",
    );
  }
  return r2Signer(R2_ACCOUNT_ID, env.R2_BUCKET_NAME, {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });
};
