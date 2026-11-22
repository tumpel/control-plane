import type { DispatchVariable } from "@tumpel/api/credentials";
import type { GitHubIssueSchema, GitHubRepositorySchema, RepositoryCredentialSourceSchema } from "@tumpel/schemas";
import type { z } from "zod";
import {
  GitHubAppConversionSchema,
  type GitHubAppManifestSchema,
  GitHubAppSchema,
  GitHubBotUserSchema,
  GitHubErrorSchema,
  type GitHubInstallationChoiceStateSchema,
  GitHubInstallationPermissionsSchema,
  GitHubInstallationRecordSchema,
  GitHubInstallationRepositoriesSchema,
  GitHubInstallationTokenSchema,
  type GitHubInstallerIdentityStateSchema,
  type GitHubInstallStateSchema,
  GitHubIssueRecordSchema,
  GitHubIssueRecordsSchema,
  type GitHubManifestStateSchema,
  GitHubUserInstallationsSchema,
  GitHubUserSchema,
  GitHubUserTokenSchema,
} from "./github-schemas.ts";
import type { Problem } from "./http.ts";

export type GitHubAppManifest = z.infer<typeof GitHubAppManifestSchema>;
export type GitHubAppConversion = z.infer<typeof GitHubAppConversionSchema>;
export type GitHubInstallationRecord = z.infer<typeof GitHubInstallationRecordSchema>;
export type RepositoryCredentialSource = z.infer<typeof RepositoryCredentialSourceSchema>;
export type GitHubRepositorySummary = z.infer<typeof GitHubRepositorySchema>;
export type GitHubIssueSummary = z.infer<typeof GitHubIssueSchema>;
export type GitHubIssueRecord = z.infer<typeof GitHubIssueRecordSchema>;
export type GitHubState =
  | z.infer<typeof GitHubManifestStateSchema>
  | z.infer<typeof GitHubInstallStateSchema>
  | z.infer<typeof GitHubInstallationChoiceStateSchema>
  | z.infer<typeof GitHubInstallerIdentityStateSchema>;
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const GITHUB_WEB = "https://github.com";
export const APP_SETUP_PATH = "/github/app/setup";
export const APP_CREATED_PATH = "/github/app/created";
export const APP_INSTALLED_PATH = "/github/app/installed";
export const WEBHOOK_PATH = "/github/webhook";
export const STATE_KEY_PURPOSE = "tumpel-github-state-v1";
export const STATE_TTL_MS = 3_600_000;
export const GITHUB_TIMEOUT_MS = 10_000;
export const INSTALL_REQUEST_TTL_MS = 604_800_000;
const API_VERSION = "2022-11-28";
export const API_MEDIA_TYPE = "application/vnd.github+json";
const JSON_MEDIA_TYPE = "application/json";
const APP_NAME_LIMIT = 34;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const base64Url = (bytes: Uint8Array): string => {
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
];

export const AGENT_PERMISSIONS = {
  actions: "write",
  administration: "write",
  artifact_metadata: "write",
  attestations: "write",
  checks: "write",
  code_quality: "read",
  security_events: "write",
  statuses: "write",
  contents: "write",
  repository_custom_properties: "write",
  vulnerability_alerts: "write",
  dependabot_secrets: "write",
  deployments: "write",
  discussions: "write",
  environments: "write",
  issues: "write",
  merge_queues: "write",
  metadata: "read",
  packages: "write",
  pages: "write",
  repository_projects: "write",
  pull_requests: "write",
  secret_scanning_alerts: "write",
  secrets: "write",
  actions_variables: "write",
  repository_hooks: "write",
  workflows: "write",
  members: "read",
  organization_projects: "write",
} as const;

export const appManifest = (origin: string): GitHubAppManifest => ({
  name: `tumpel ${new URL(origin).hostname.replaceAll(".", "-")}`.slice(0, APP_NAME_LIMIT).trim(),
  url: origin,
  description: "Tumpel boxes clone, push and open pull requests with a short-lived token of this App.",
  hook_attributes: { url: `${origin}${WEBHOOK_PATH}`, active: true },
  redirect_url: `${origin}${APP_CREATED_PATH}`,
  callback_urls: [`${origin}${APP_INSTALLED_PATH}`],
  setup_url: `${origin}${APP_INSTALLED_PATH}`,
  setup_on_update: true,
  public: true,
  request_oauth_on_install: true,
  default_permissions: AGENT_PERMISSIONS,
  default_events: APP_EVENTS,
});

export const manifestAction = (organization: string, state: string): string => {
  const base =
    organization === ""
      ? `${GITHUB_WEB}/settings/apps/new`
      : `${GITHUB_WEB}/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
};

export type ReturnCheck = { ok: true; returnUrl: string | undefined } | { ok: false; detail: string };

export const dashboardReturn = (returnUrl: string | null, dashboardOrigin: string | undefined): ReturnCheck => {
  if (returnUrl === null) return { ok: true, returnUrl: undefined };
  if (!dashboardOrigin) return { ok: false, detail: "this control plane has no DASHBOARD_ORIGIN to return to" };
  if (!URL.canParse(returnUrl)) return { ok: false, detail: `returnUrl ${returnUrl} is not a URL` };
  const parsed = new URL(returnUrl);
  if (parsed.origin !== dashboardOrigin) {
    return { ok: false, detail: `returnUrl ${returnUrl} is not on the dashboard's origin ${dashboardOrigin}` };
  }
  return { ok: true, returnUrl: parsed.href };
};

export const installUrl = (slug: string, state: string, gitHubAccountId: number | null): string => {
  const app = `${GITHUB_WEB}/apps/${encodeURIComponent(slug)}/installations/new`;
  if (gitHubAccountId === null) return `${app}?state=${encodeURIComponent(state)}`;
  return `${app}/permissions?${new URLSearchParams({ target_id: String(gitHubAccountId), state })}`;
};

export const authorizeUrl = (web: string, clientId: string, redirectUri: string, state: string): string =>
  `${web}/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state })}`;

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | null =>
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

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const failed = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const callGitHub = async <T>(
  fetcher: Fetch,
  request: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    url: string;
    accept: string;
    bearer: string | null;
    body: unknown;
  },
  schema: z.ZodType<T>,
  answerName: string,
): Promise<GitHubAnswer<T>> => {
  const { method, url, accept, bearer, body } = request;
  const path = url.replace(/\?.*$/, "");
  const headers: Record<string, string> = {
    accept,
    "x-github-api-version": API_VERSION,
    "user-agent": "tumpel",
  };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  if (body !== null) headers["content-type"] = "application/json";
  const response = await fetcher(url, {
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
  status: "Active" | "Suspended";
}

export interface GitHubRepository {
  owner: string;
  name: string;
}

export const githubRepository = (repository: string): GitHubRepository | null => {
  const matched = /^(?:(?:https:\/\/)?github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    repository.trim(),
  );
  return matched?.[1] === undefined || matched[2] === undefined ? null : { owner: matched[1], name: matched[2] };
};

export const repositoryUrl = (target: GitHubRepository): string =>
  `${GITHUB_WEB}/${target.owner}/${target.name}`.toLowerCase();

export const notARepository = (repository: string): Problem => ({
  code: "InvalidRequest",
  title: "Not a GitHub repository",
  detail: `${repository} is not a GitHub repository; a repository is owner/name, github.com/owner/name or https://github.com/owner/name, with or without .git`,
  fix: "Pass https://github.com/owner/name",
});

export type Minted =
  | { kind: "Minted"; token: string; expiresAt: string; permissions: Record<string, string> }
  | { kind: "NoToken" }
  | { kind: "Outside"; detail: string }
  | { kind: "Refused"; detail: string };

export const installationSettings = (installationId: number): string =>
  `${GITHUB_WEB}/settings/installations/${installationId}`;

const OUTSIDE_STATUSES = [404, 422];

export const uncovered = (accounts: string[], target: GitHubRepository): Minted => {
  if (accounts.length === 0) return { kind: "NoToken" };
  return {
    kind: "Outside",
    detail: `${target.owner}/${target.name} belongs to ${target.owner}, and the tenant's GitHub App installations cover repositories of ${accounts.join(", ")} only; start the session on a repository of one of them, connect GitHub for ${target.owner}, or add a GITHUB_TOKEN for ${target.owner} to the persona's secret set`,
  };
};

export type Permissions = Readonly<Record<string, "read" | "write">>;

export type TokenScope = { kind: "Exact"; permissions: Permissions } | { kind: "Granted"; needs: Permissions };

export const CONTENTS_READ: TokenScope = { kind: "Exact", permissions: { contents: "read" } };

export const AGENT_SCOPE: TokenScope = { kind: "Granted", needs: AGENT_PERMISSIONS };

export const grantedNeeds = (needs: Permissions, granted: Record<string, string>): Permissions =>
  Object.fromEntries(
    Object.entries(needs).flatMap(([name, level]) => {
      const held = granted[name];
      if (held === undefined) return [];
      return [[name, level === "write" && held !== "read" ? "write" : "read"]];
    }),
  );

const scopedPermissions = async (
  fetcher: Fetch,
  api: string,
  app: AppKey,
  installationId: number,
  now: number,
  scope: TokenScope,
): Promise<GitHubAnswer<Permissions>> => {
  if (scope.kind === "Exact") return { ok: true, value: scope.permissions };
  const read = await callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${api}/app/installations/${installationId}`,
      accept: API_MEDIA_TYPE,
      bearer: await appJwt(app.clientId, app.privateKey, now),
      body: null,
    },
    GitHubInstallationPermissionsSchema,
    "GitHubInstallationPermissions",
  );
  return read.ok ? { ok: true, value: grantedNeeds(scope.needs, read.value.permissions) } : read;
};

const accessToken = async (
  fetcher: Fetch,
  api: string,
  app: AppKey,
  installationId: number,
  now: number,
  scope: TokenScope,
  repositories: string[] | null,
): Promise<GitHubAnswer<z.infer<typeof GitHubInstallationTokenSchema>>> => {
  const permissions = await scopedPermissions(fetcher, api, app, installationId, now, scope);
  if (!permissions.ok) return permissions;
  return callGitHub(
    fetcher,
    {
      method: "POST",
      url: `${api}/app/installations/${installationId}/access_tokens`,
      accept: API_MEDIA_TYPE,
      bearer: await appJwt(app.clientId, app.privateKey, now),
      body:
        repositories === null ? { permissions: permissions.value } : { repositories, permissions: permissions.value },
    },
    GitHubInstallationTokenSchema,
    "GitHubInstallationToken",
  );
};

export const mintInstallationToken = async (
  fetcher: Fetch,
  api: string,
  app: AppKey,
  installation: Installation,
  target: GitHubRepository,
  now: number,
  scope: TokenScope,
): Promise<Minted> => {
  if (installation.status === "Suspended") {
    return {
      kind: "Outside",
      detail: `the tenant's GitHub App installation on ${installation.accountLogin} is suspended; unsuspend it at ${installationSettings(installation.installationId)}, or add a GITHUB_TOKEN for ${target.owner} to the persona's secret set`,
    };
  }
  const { installationId } = installation;
  const answer = await accessToken(fetcher, api, app, installationId, now, scope, [target.name]);
  if (answer.ok) {
    return {
      kind: "Minted",
      token: answer.value.token,
      expiresAt: answer.value.expires_at,
      permissions: answer.value.permissions,
    };
  }
  if (OUTSIDE_STATUSES.includes(answer.status)) {
    return {
      kind: "Outside",
      detail: `${answer.detail}; add ${target.owner}/${target.name} to the installation at ${installationSettings(installationId)}, connect GitHub again, or add a GITHUB_TOKEN to the persona's secret set, then send the turn again`,
    };
  }
  return {
    kind: "Refused",
    detail: `${answer.detail}; send the turn again once GitHub answers, and check https://www.githubstatus.com if it keeps failing`,
  };
};

export const readInstallation = async (
  fetcher: Fetch,
  api: string,
  app: AppKey,
  installationId: number,
  now: number,
): Promise<GitHubAnswer<GitHubInstallationRecord>> =>
  callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${api}/app/installations/${installationId}`,
      accept: API_MEDIA_TYPE,
      bearer: await appJwt(app.clientId, app.privateKey, now),
      body: null,
    },
    GitHubInstallationRecordSchema,
    "GitHubInstallation",
  );

export const readAppPermissions = async (
  fetcher: Fetch,
  api: string,
  app: AppKey,
  now: number,
): Promise<GitHubAnswer<Record<string, string>>> => {
  const answer = await callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${api}/app`,
      accept: API_MEDIA_TYPE,
      bearer: await appJwt(app.clientId, app.privateKey, now),
      body: null,
    },
    GitHubAppSchema,
    "GitHubApp",
  );
  return answer.ok ? { ok: true, value: answer.value.permissions } : answer;
};

export const mintInstallationWideToken = async (
  fetcher: Fetch,
  api: string,
  app: AppKey,
  installationId: number,
  now: number,
  scope: TokenScope,
): Promise<GitHubAnswer<string>> => {
  const answer = await accessToken(fetcher, api, app, installationId, now, scope, null);
  return answer.ok ? { ok: true, value: answer.value.token } : answer;
};

const PAGE_SIZE = 100;

export const listInstallationRepositories = async (
  fetcher: Fetch,
  api: string,
  token: string,
): Promise<GitHubAnswer<GitHubRepositorySummary[]>> => {
  const repositories: GitHubRepositorySummary[] = [];
  for (let page = 1; ; page += 1) {
    const answer = await callGitHub(
      fetcher,
      {
        method: "GET",
        url: `${api}/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
        accept: API_MEDIA_TYPE,
        bearer: token,
        body: null,
      },
      GitHubInstallationRepositoriesSchema,
      "GitHubInstallationRepositories",
    );
    if (!answer.ok) return answer;
    for (const repository of answer.value.repositories) {
      repositories.push({
        owner: repository.owner.login,
        name: repository.name,
        defaultBranch: repository.default_branch,
        private: repository.private,
        htmlUrl: repository.html_url,
      });
    }
    const done = answer.value.repositories.length < PAGE_SIZE || repositories.length >= answer.value.total_count;
    if (done) return { ok: true, value: repositories };
  }
};

const issuesUrl = (api: string, target: GitHubRepository): string =>
  `${api}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/issues`;

export const listOpenIssues = async (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
): Promise<GitHubAnswer<GitHubIssueSummary[]>> => {
  const answer = await callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${issuesUrl(api, target)}?state=open&sort=updated&direction=desc&per_page=${PAGE_SIZE}`,
      accept: API_MEDIA_TYPE,
      bearer: token,
      body: null,
    },
    GitHubIssueRecordsSchema,
    "GitHubIssue[]",
  );
  if (!answer.ok) return answer;
  return {
    ok: true,
    value: answer.value.flatMap((issue) =>
      issue.pull_request === undefined
        ? [
            {
              issueNumber: issue.number,
              title: issue.title,
              htmlUrl: issue.html_url,
              labels: issue.labels.map((label) => label.name),
              updatedAt: issue.updated_at,
            },
          ]
        : [],
    ),
  };
};

export const readIssue = (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
  issueNumber: number,
): Promise<GitHubAnswer<GitHubIssueRecord>> =>
  callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${issuesUrl(api, target)}/${issueNumber}`,
      accept: API_MEDIA_TYPE,
      bearer: token,
      body: null,
    },
    GitHubIssueRecordSchema,
    "GitHubIssue",
  );

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export type RecordedInstaller = { kind: "Recorded"; githubUserId: number } | { kind: "Unrecorded" };

export type Installer =
  | { kind: "Installer"; installation: GitHubInstallationRecord }
  | { kind: "NotInstaller"; detail: string }
  | { kind: "InstallerUnknown"; detail: string };

export type InstallationAccess =
  | { kind: "Accessible"; user: GitHubUser; installation: GitHubInstallationRecord }
  | { kind: "NotInstaller"; detail: string }
  | { kind: "Failed"; detail: string };

export const personDetail = (answer: { status: number; detail: string }, asked: string): string =>
  answer.status >= 200 && answer.status < 300
    ? `GitHub answered ${asked} in a form tumpel does not read`
    : answer.detail;

export const installedBy = (
  user: GitHubUser,
  installation: GitHubInstallationRecord,
  recorded: RecordedInstaller,
): Installer => {
  const { id, login, type } = installation.account;
  if (type === "User") {
    if (user.githubUserId === id) return { kind: "Installer", installation };
    return {
      kind: "NotInstaller",
      detail: `installation ${installation.id} is on the personal account ${login}, and you authorized GitHub as ${user.login}; only ${login} connects their own account`,
    };
  }
  if (recorded.kind === "Unrecorded") {
    return {
      kind: "InstallerUnknown",
      detail: `GitHub has not yet sent this control plane the installation notice that names who installed the App on the organization ${login}`,
    };
  }
  if (recorded.githubUserId === user.githubUserId) return { kind: "Installer", installation };
  return {
    kind: "NotInstaller",
    detail: `you authorized GitHub as ${user.login}, who did not install the App on the organization ${login}; only the person who installed it connects ${login}`,
  };
};

export const exchangeUserCode = async (
  fetcher: Fetch,
  web: string,
  client: OAuthClient,
  code: string,
): Promise<GitHubAnswer<string>> => {
  const exchanged = await callGitHub(
    fetcher,
    {
      method: "POST",
      url: `${web}/login/oauth/access_token`,
      accept: JSON_MEDIA_TYPE,
      bearer: null,
      body: { client_id: client.clientId, client_secret: client.clientSecret, code },
    },
    GitHubUserTokenSchema,
    "GitHubUserToken",
  );
  if (!exchanged.ok) return { ...exchanged, detail: personDetail(exchanged, "the sign-in code") };
  if ("error" in exchanged.value) {
    return {
      ok: false,
      status: 200,
      detail: `GitHub refused the authorization code with ${exchanged.value.error}: ${exchanged.value.error_description}`,
    };
  }
  return { ok: true, value: exchanged.value.access_token };
};

export const verifyInstaller = async (
  fetcher: Fetch,
  origins: { api: string; web: string },
  client: OAuthClient,
  code: string,
  installationId: number,
): Promise<InstallationAccess> => {
  const { api, web } = origins;
  const exchanged = await exchangeUserCode(fetcher, web, client, code);
  if (!exchanged.ok) return { kind: "Failed", detail: exchanged.detail };
  const token = exchanged.value;
  const listed = await callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${api}/user/installations?per_page=100`,
      accept: API_MEDIA_TYPE,
      bearer: token,
      body: null,
    },
    GitHubUserInstallationsSchema,
    "GitHubUserInstallations",
  );
  if (!listed.ok) return { kind: "Failed", detail: personDetail(listed, "the installations you can access") };
  const found = listed.value.installations.find((candidate) => candidate.id === installationId);
  if (found === undefined) {
    return {
      kind: "NotInstaller",
      detail: `installation ${installationId} is not among the installations of this stage's GitHub App that the GitHub account you authorized can access`,
    };
  }
  const installation = GitHubInstallationRecordSchema.safeParse(found);
  if (!installation.success) {
    return {
      kind: "Failed",
      detail: `installation ${installationId} is on an account tumpel cannot link, such as an enterprise; install the App on a user or organization account`,
    };
  }
  const user = await tokenUser(fetcher, api, token);
  if (!user.ok) return { kind: "Failed", detail: personDetail(user, "who you are") };
  return { kind: "Accessible", user: user.value, installation: installation.data };
};

export const convertManifest = async (
  fetcher: Fetch,
  api: string,
  code: string,
): Promise<GitHubAnswer<GitHubAppConversion>> => {
  return callGitHub(
    fetcher,
    {
      method: "POST",
      url: `${api}/app-manifests/${encodeURIComponent(code)}/conversions`,
      accept: API_MEDIA_TYPE,
      bearer: null,
      body: null,
    },
    GitHubAppConversionSchema,
    "GitHubAppConversion",
  );
};

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

export const verifyWebhookSignature = async (
  secret: string,
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> => {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (hex === undefined) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify("HMAC", key, hexBytes(hex), body);
};

export const signState = async <T>(key: CryptoKey, claims: T): Promise<string> => {
  const body = base64UrlJson(claims);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64Url(new Uint8Array(signature))}`;
};

export type StateCheck<T> = { ok: true; claims: T } | { ok: false; reason: string };

export const readSignedState = async <T>(
  key: CryptoKey,
  state: string,
  schema: z.ZodType<T>,
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
  if (!parsed.success) return { ok: false, reason: "the state was signed for another step or another flow" };
  return { ok: true, claims: parsed.data };
};

export const readState = async <T extends GitHubState>(
  key: CryptoKey,
  state: string,
  schema: z.ZodType<T>,
  now: number,
): Promise<StateCheck<T>> => {
  const read = await readSignedState(key, state, schema);
  if (!read.ok) return read;
  if (Date.parse(read.claims.expiresAt) <= now) {
    return { ok: false, reason: `the state expired at ${read.claims.expiresAt}` };
  }
  return read;
};

export interface CommitIdentity {
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface GitHubUser {
  githubUserId: number;
  login: string;
}

export const commitIdentity = (user: GitHubUser): CommitIdentity => ({
  gitAuthorName: user.login,
  gitAuthorEmail: `${user.githubUserId}+${user.login}@users.noreply.github.com`,
});

export const botLogin = (slug: string): string => `${slug}[bot]`;

export const tokenUser = async (fetcher: Fetch, api: string, token: string): Promise<GitHubAnswer<GitHubUser>> => {
  const answer = await callGitHub(
    fetcher,
    { method: "GET", url: `${api}/user`, accept: API_MEDIA_TYPE, bearer: token, body: null },
    GitHubUserSchema,
    "GitHubUser",
  );
  return answer.ok ? { ok: true, value: { githubUserId: answer.value.id, login: answer.value.login } } : answer;
};

export const botUserId = async (
  fetcher: Fetch,
  api: string,
  slug: string,
  bearer: string | null,
): Promise<GitHubAnswer<number>> => {
  const answer = await callGitHub(
    fetcher,
    { method: "GET", url: `${api}/users/${botLogin(slug)}`, accept: API_MEDIA_TYPE, bearer, body: null },
    GitHubBotUserSchema,
    "GitHubBotUser",
  );
  return answer.ok ? { ok: true, value: answer.value.id } : answer;
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

export type RepositoryCredential =
  | { kind: "Ready"; variables: DispatchVariable[]; source: RepositoryCredentialSource }
  | { kind: "Refused"; detail: string };

export const OWNER_TOKENS = "TUMPEL_GITHUB_TOKENS";

export interface OwnerToken {
  owner: string;
  token: string;
}

export const mintOwnerTokens = async (
  fetcher: Fetch,
  api: string,
  app: AppKey,
  installations: Installation[],
  target: GitHubRepository,
  now: number,
): Promise<GitHubAnswer<OwnerToken[]>> => {
  const active = installations.filter((installation) => installation.status === "Active");
  const answers = await Promise.all(
    active.map(async (installation) => ({
      owner: installation.accountLogin.toLowerCase(),
      answer: await mintInstallationWideToken(fetcher, api, app, installation.installationId, now, AGENT_SCOPE),
    })),
  );
  const tokens: OwnerToken[] = [];
  for (const { owner, answer } of answers) {
    if (!answer.ok && owner === target.owner.toLowerCase()) {
      return { ...answer, detail: `the installation token for ${owner}: ${answer.detail}` };
    }
    if (!answer.ok) continue;
    tokens.push({ owner, token: answer.value });
  }
  return { ok: true, value: tokens };
};

export const withOwnerTokens = (
  variables: DispatchVariable[],
  tokens: OwnerToken[],
  target: GitHubRepository,
): DispatchVariable[] => {
  const own = tokens.find(({ owner }) => owner === target.owner.toLowerCase());
  const kept = variables.filter((variable) => variable.name !== OWNER_TOKENS);
  const routed = { name: OWNER_TOKENS, value: tokens.map(({ owner, token }) => `${owner}=${token}`).join(" ") };
  if (own === undefined) return [...kept, routed];
  return [...withRepositoryToken(kept, own.token).variables, routed];
};

export const repositoryCredential = (variables: DispatchVariable[], minted: Minted): RepositoryCredential => {
  if (minted.kind === "Refused") return { kind: "Refused", detail: minted.detail };
  if (minted.kind === "Minted") return { kind: "Ready", ...withRepositoryToken(variables, minted.token) };
  const holdsToken = variables.some((variable) => variable.name === REPOSITORY_TOKEN);
  if (minted.kind === "Outside" && !holdsToken) return { kind: "Refused", detail: minted.detail };
  return { kind: "Ready", ...withRepositoryToken(variables, null) };
};
