import {
  GitHubAppConversionSchema,
  type GitHubAppManifestSchema,
  GitHubErrorSchema,
  GitHubInstallationRecordSchema,
  GitHubInstallationTokenSchema,
  type GitHubInstallStateSchema,
  type GitHubManifestStateSchema,
  type RepositoryCredentialSourceSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import type { DispatchVariable } from "./dispatch-variables.ts";

export type GitHubAppManifest = z.infer<typeof GitHubAppManifestSchema>;
export type GitHubAppConversion = z.infer<typeof GitHubAppConversionSchema>;
export type GitHubInstallationRecord = z.infer<typeof GitHubInstallationRecordSchema>;
export type RepositoryCredentialSource = z.infer<typeof RepositoryCredentialSourceSchema>;
export type GitHubState = z.infer<typeof GitHubManifestStateSchema> | z.infer<typeof GitHubInstallStateSchema>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
export const APP_SETUP_PATH = "/github/app/setup";
export const APP_CREATED_PATH = "/github/app/created";
export const APP_INSTALLED_PATH = "/github/app/installed";
export const WEBHOOK_PATH = "/github/webhook";
export const STATE_KEY_PURPOSE = "tumpel-github-state-v1";
export const STATE_TTL_MS = 3_600_000;
export const GITHUB_TIMEOUT_MS = 10_000;
const API_VERSION = "2022-11-28";
const APP_NAME_LIMIT = 34;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const APP_EVENTS = [
  "check_run",
  "check_suite",
  "discussion",
  "discussion_comment",
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "status",
  "workflow_job",
  "workflow_run",
];

export const appManifest = (origin: string): GitHubAppManifest => ({
  name: `tumpel ${new URL(origin).hostname.split(".")[0] ?? ""}`.slice(0, APP_NAME_LIMIT).trim(),
  url: origin,
  description: "Tumpel boxes clone, push and open pull requests with a short-lived token of this App.",
  hook_attributes: { url: `${origin}${WEBHOOK_PATH}`, active: true },
  redirect_url: `${origin}${APP_CREATED_PATH}`,
  setup_url: `${origin}${APP_INSTALLED_PATH}`,
  setup_on_update: false,
  public: false,
  request_oauth_on_install: false,
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    metadata: "read",
    checks: "write",
    statuses: "write",
    workflows: "write",
    discussions: "write",
    actions: "read",
  },
  default_events: APP_EVENTS,
});

export const manifestAction = (organization: string, state: string): string => {
  const base =
    organization === ""
      ? `${GITHUB_WEB}/settings/apps/new`
      : `${GITHUB_WEB}/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
};

export const installUrl = (slug: string, state: string): string =>
  `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | null =>
  /^[A-Za-z0-9_-]+$/.test(text) ? fromBase64(text.replaceAll("-", "+").replaceAll("_", "/")) : null;

const derLength = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
};

const der = (tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const head = [tag, ...derLength(length)];
  const bytes = new Uint8Array(head.length + length);
  bytes.set(head, 0);
  let offset = head.length;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const PKCS8_VERSION = Uint8Array.of(0x02, 0x01, 0x00);
const RSA_ENCRYPTION = Uint8Array.of(
  0x30,
  0x0d,
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
  0x05,
  0x00,
);

export const pkcs8FromPem = (pem: string): Uint8Array<ArrayBuffer> => {
  const kind = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----/.exec(pem)?.[1];
  if (kind === undefined) {
    throw new Error(
      "the GitHub App private key is not a PKCS#1 or PKCS#8 PEM; generate a new private key in the App's settings on GitHub",
    );
  }
  const body = fromBase64(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, ""));
  return kind === "PRIVATE KEY" ? body : der(0x30, PKCS8_VERSION, RSA_ENCRYPTION, der(0x04, body));
};

export const importAppKey = (pkcs8: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);

const base64UrlJson = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)));

export const appJwt = async (clientId: string, privateKey: CryptoKey, now: number): Promise<string> => {
  const seconds = Math.floor(now / 1000);
  const signed = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({ iat: seconds - 60, exp: seconds + 540, iss: clientId })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(signed));
  return `${signed}.${base64Url(new Uint8Array(signature))}`;
};

export type GitHubAnswer<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const failed = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const callGitHub = async <T>(
  fetcher: Fetch,
  request: { method: "GET" | "POST"; path: string; bearer: string | null; body: unknown },
  schema: z.ZodType<T>,
  answerName: string,
): Promise<GitHubAnswer<T>> => {
  const { method, path, bearer, body } = request;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": "tumpel",
  };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  if (body !== null) headers["content-type"] = "application/json";
  const response = await fetcher(`${GITHUB_API}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  }).catch(failed);
  if (response instanceof Error) {
    return {
      ok: false,
      status: 0,
      detail: `GitHub did not answer ${method} ${path} within ${GITHUB_TIMEOUT_MS / 1000} s: ${response.message}`,
    };
  }
  const text = await response.text();
  if (!response.ok) {
    const error = GitHubErrorSchema.safeParse(parseJson(text));
    return {
      ok: false,
      status: response.status,
      detail: `GitHub answered ${method} ${path} with ${response.status}: ${error.success ? error.data.message : "no error message"}`,
    };
  }
  const parsed = schema.safeParse(parseJson(text));
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    status: response.status,
    detail: `GitHub answered ${method} ${path} with a body that is not a ${answerName}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`,
  };
};

export interface AppKey {
  clientId: string;
  privateKey: CryptoKey;
}

export interface Installation {
  installationId: number;
  accountLogin: string;
}

export interface GitHubRepository {
  owner: string;
  name: string;
}

export const githubRepository = (repository: string): GitHubRepository | null => {
  const matched = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(repository);
  return matched?.[1] === undefined || matched[2] === undefined ? null : { owner: matched[1], name: matched[2] };
};

export type Minted =
  | { kind: "Minted"; token: string; expiresAt: string }
  | { kind: "NoToken" }
  | { kind: "Refused"; detail: string };

const installationSettings = (installationId: number): string =>
  `${GITHUB_WEB}/settings/installations/${installationId}`;

export const mintInstallationToken = async (
  fetcher: Fetch,
  app: AppKey,
  installation: Installation,
  repository: string,
  now: number,
): Promise<Minted> => {
  const target = githubRepository(repository);
  if (target === null) return { kind: "NoToken" };
  const { installationId, accountLogin } = installation;
  if (target.owner.toLowerCase() !== accountLogin.toLowerCase()) {
    return {
      kind: "Refused",
      detail: `${repository} belongs to ${target.owner}, and the tenant's GitHub App installation covers repositories of ${accountLogin} only; start the session on a repository of ${accountLogin}, or install the App on ${target.owner} with tumpel github start`,
    };
  }
  const answer = await callGitHub(
    fetcher,
    {
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      bearer: await appJwt(app.clientId, app.privateKey, now),
      body: { repositories: [target.name] },
    },
    GitHubInstallationTokenSchema,
    "GitHubInstallationToken",
  );
  if (answer.ok) return { kind: "Minted", token: answer.value.token, expiresAt: answer.value.expires_at };
  return {
    kind: "Refused",
    detail: `${answer.detail}; add ${target.owner}/${target.name} to the installation at ${installationSettings(installationId)}, or install the App again with tumpel github start, then send the turn again`,
  };
};

export const readInstallation = async (
  fetcher: Fetch,
  app: AppKey,
  installationId: number,
  now: number,
): Promise<GitHubAnswer<GitHubInstallationRecord>> => {
  return callGitHub(
    fetcher,
    {
      method: "GET",
      path: `/app/installations/${installationId}`,
      bearer: await appJwt(app.clientId, app.privateKey, now),
      body: null,
    },
    GitHubInstallationRecordSchema,
    "GitHubInstallationRecord",
  );
};

export const convertManifest = async (fetcher: Fetch, code: string): Promise<GitHubAnswer<GitHubAppConversion>> => {
  return callGitHub(
    fetcher,
    { method: "POST", path: `/app-manifests/${encodeURIComponent(code)}/conversions`, bearer: null, body: null },
    GitHubAppConversionSchema,
    "GitHubAppConversion",
  );
};

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

export const verifyWebhookSignature = async (secret: string, body: string, header: string | null): Promise<boolean> => {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (hex === undefined) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify("HMAC", key, hexBytes(hex), encoder.encode(body));
};

export const signState = async (key: CryptoKey, claims: GitHubState): Promise<string> => {
  const body = base64UrlJson(claims);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64Url(new Uint8Array(signature))}`;
};

export type StateCheck<T> = { ok: true; claims: T } | { ok: false; reason: string };

export const readState = async <T extends GitHubState>(
  key: CryptoKey,
  state: string,
  schema: z.ZodType<T>,
  now: number,
): Promise<StateCheck<T>> => {
  const [body, signature, extra] = state.split(".");
  const signatureBytes = signature === undefined ? null : fromBase64Url(signature);
  const bodyBytes = body === undefined ? null : fromBase64Url(body);
  if (body === undefined || signatureBytes === null || bodyBytes === null || extra !== undefined) {
    return { ok: false, reason: "the state is not one this control plane signed" };
  }
  if (!(await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(body)))) {
    return { ok: false, reason: "the state is not one this control plane signed" };
  }
  const parsed = schema.safeParse(parseJson(decoder.decode(bodyBytes)));
  if (!parsed.success) return { ok: false, reason: "the state was signed for another step of the GitHub setup" };
  if (Date.parse(parsed.data.expiresAt) <= now) {
    return { ok: false, reason: `the state expired at ${parsed.data.expiresAt}` };
  }
  return { ok: true, claims: parsed.data };
};

export const REPOSITORY_TOKEN = "GITHUB_TOKEN";
const REPOSITORY_TOKEN_NAMES = [REPOSITORY_TOKEN, "GH_TOKEN"];

export const withRepositoryToken = (
  variables: DispatchVariable[],
  token: string | null,
): { variables: DispatchVariable[]; source: RepositoryCredentialSource } => {
  if (token === null) {
    const source = variables.some((variable) => variable.name === REPOSITORY_TOKEN) ? "SecretSet" : "None";
    return { variables, source };
  }
  return {
    variables: [
      ...variables.filter((variable) => !REPOSITORY_TOKEN_NAMES.includes(variable.name)),
      ...REPOSITORY_TOKEN_NAMES.map((name) => ({ name, value: token })),
    ],
    source: "GitHubApp",
  };
};
