import {
  GitHubAccountListSchema,
  GitHubConnectionSchema,
  GitHubInstallationSchema,
  GitHubInstallStartSchema,
  GitHubIssueSchema,
  GitHubRefreshStartSchema,
  GitHubRepositoryPathSchema,
  GitHubRepositorySchema,
  type WhoamiSchema,
} from "@tumpel/api/schemas";
import {
  appBadOrganizationPage,
  appCreatedPage,
  appExistsPage,
  appGitHubRefusedPage,
  appNothingToCreatePage,
  appRequestRefusedPage,
  appSetupPage,
  gitHubConnectedPage,
  installationChoicePage,
  installationInUsePage,
  installationRequestedPage,
  installerUnconfirmedPage,
  installNothingToConnectPage,
  installRefusedPage,
  noGitHubAppPage,
  notTheInstallerPage,
  signInAgainPage,
} from "@tumpel/pages";
import { z } from "zod";
import {
  APP_CREATED_PATH,
  APP_INSTALLED_PATH,
  APP_SETUP_PATH,
  type AppKey,
  appManifest,
  authorizeUrl,
  botUserId,
  convertManifest,
  dashboardReturn,
  type Fetch,
  type GitHubAnswer,
  type GitHubInstallationRecord,
  installationSettings,
  installedBy,
  installUrl,
  listInstallationRepositories,
  listOpenIssues,
  manifestAction,
  mintInstallationToken,
  mintInstallationWideToken,
  type OAuthClient,
  parseJson,
  type RecordedInstaller,
  readState,
  STATE_KEY_PURPOSE,
  STATE_TTL_MS,
  signState,
  uncovered,
  verifyInstaller,
  verifyWebhookSignature,
  WEBHOOK_PATH,
} from "./github.ts";
import { accountList, accountRows, type LinkDecision, linkDecision, readAccounts } from "./github-accounts.ts";
import {
  GitHubInstallationChoiceQuerySchema,
  GitHubInstallationChoiceStateSchema,
  GitHubInstallationEventSchema,
  GitHubInstallerIdentityCallbackSchema,
  GitHubInstallerIdentityStateSchema,
  GitHubInstallStateSchema,
  GitHubManifestCallbackSchema,
  GitHubManifestStateSchema,
  GitHubSetupActionSchema,
  GitHubSetupCallbackSchema,
  GitHubWorkflowRunEventSchema,
} from "./github-schemas.ts";
import {
  appKey,
  type GitHubInstallation,
  installationOn,
  installationsOf,
  linkInstallation,
  oauthClient,
  recordedInstaller,
  recordInstaller,
  refreshInstallation,
  setInstallationStatus,
  storeApp,
  storedApp,
  tenantOfInstallation,
  unlinkInstallation,
  unlinkTenantInstallation,
  webhookSecret,
} from "./github-store.ts";
import { json, problem, seeOther } from "./http";
import { type Caller, membershipsOfEmail, whoamiOf } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { ownerRequired } from "./members";
import { dashboardOrigin, htmlPage } from "./pages";

export type PersonCheck = { ok: true; email: string } | { ok: false; reason: string };
export type SignedInPerson = (request: Request, env: Env) => Promise<PersonCheck>;
export type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const START_PATH = "/v1/github-connection/start";
const CONNECTION_PATH = "/v1/github-connection";
const INSTALLATIONS_PATH = "/v1/github-connection/installations";
const ACCOUNTS_PATH = "/v1/github-connection/accounts";
const REFRESH_PATH = "/v1/github-connection/refresh";
const INSTALLATION_PATH = /^\/v1\/github-connection\/installations\/([^/]+)$/;
const REPOSITORIES_PATH = "/v1/github-connection/repositories";
const ISSUES_PATH = /^\/v1\/github-connection\/repositories\/([^/]+)\/([^/]+)\/issues$/;
const fetcher: Fetch = (url, init) => fetch(url, init);
const stateKey = (env: Env): Promise<CryptoKey> => keyStoreOf(env).signingKey(STATE_KEY_PURPOSE);
const expiry = (now: number): string => new Date(now + STATE_TTL_MS).toISOString();
const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");

const appMissing = (origin: string): Response =>
  problem(409, {
    code: "GitHubAppMissing",
    title: "No GitHub App",
    detail: "this stage has no GitHub App yet",
    fix: `Create it once in a browser at ${origin}${APP_SETUP_PATH}`,
  });

const handleConnection = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  const app = await storedApp(env.DB);
  if (app === null) {
    return json(
      GitHubConnectionSchema.parse({
        tenantId: caller.tenantId,
        app: { state: "AppMissing", setupUrl: `${url.origin}${APP_SETUP_PATH}` },
      }),
    );
  }
  return json(GitHubConnectionSchema.parse({ tenantId: caller.tenantId, app: { state: "Ready", appSlug: app.slug } }));
};

const handleList = async (caller: Caller, env: Env): Promise<Response> =>
  json(
    (await installationsOf(env.DB, caller.tenantId)).map((installation) =>
      GitHubInstallationSchema.parse(installation),
    ),
  );

const returnRefused = (operation: string, detail: string, env: Env): Response =>
  problem(400, {
    code: "InvalidRequest",
    title: "Return URL refused",
    detail: `${operation} refused the return URL: ${detail}`,
    fix: `Leave returnUrl out, or name a page on ${env.DASHBOARD_ORIGIN || "the dashboard"}`,
  });

const tenantState = async (
  caller: Caller,
  env: Env,
  expiresAt: string,
  returnUrl: string | undefined,
  gitHubAccountId: number | null,
): Promise<string> => {
  const { principal } = await whoamiOf(env.DB, caller);
  return signState(await stateKey(env), {
    purpose: "Installation",
    tenantId: caller.tenantId,
    email: principal.email,
    expiresAt,
    ...(returnUrl === undefined ? {} : { returnUrl }),
    ...(gitHubAccountId === null ? {} : { gitHubAccountId }),
  });
};

const GITHUB_ID = /^[1-9][0-9]{0,15}$/;

const handleStart = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  const refused = ownerRequired(caller, "gitHubConnections.start");
  if (refused) return refused;
  const back = dashboardReturn(url.searchParams.get("returnUrl"), env.DASHBOARD_ORIGIN);
  if (!back.ok) return returnRefused("gitHubConnections.start", back.detail, env);
  const account = url.searchParams.get("gitHubAccountId");
  if (account !== null && !GITHUB_ID.test(account)) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Not a GitHub account id",
      detail: `gitHubAccountId ${account} is not a GitHub account id, which is a positive whole number`,
      fix: "Pass a gitHubAccountId that gitHubConnections.listAccounts answers, or leave it out to pick the account on GitHub",
    });
  }
  const app = await storedApp(env.DB);
  if (app === null) return appMissing(url.origin);
  const expiresAt = expiry(Date.now());
  const gitHubAccountId = account === null ? null : Number(account);
  const state = await tenantState(caller, env, expiresAt, back.returnUrl, gitHubAccountId);
  return json(GitHubInstallStartSchema.parse({ installUrl: installUrl(app.slug, state, gitHubAccountId), expiresAt }));
};

const handleListAccounts = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  if ((await storedApp(env.DB)) === null) return appMissing(url.origin);
  const stored = await env.TENANT.getByName(caller.tenantId).gitHubAccounts();
  if (stored === null) return json(GitHubAccountListSchema.parse({ state: "Unlisted" }));
  const installations = await installationsOf(env.DB, caller.tenantId);
  return json(
    GitHubAccountListSchema.parse({
      state: "Listed",
      refreshedAt: new Date(stored.refreshedAt).toISOString(),
      accounts: accountList(stored.accounts, installations),
    }),
  );
};

const handleRefresh = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  const refused = ownerRequired(caller, "gitHubConnections.refresh");
  if (refused) return refused;
  const back = dashboardReturn(url.searchParams.get("returnUrl"), env.DASHBOARD_ORIGIN);
  if (!back.ok) return returnRefused("gitHubConnections.refresh", back.detail, env);
  const client = await oauthClient(env.DB, keyStoreOf(env));
  if (client === null) return appMissing(url.origin);
  const expiresAt = expiry(Date.now());
  const state = await tenantState(caller, env, expiresAt, back.returnUrl, null);
  const authorizeAt = authorizeUrl(env.GITHUB_WEB_ORIGIN, client.clientId, `${url.origin}${APP_INSTALLED_PATH}`, state);
  return json(GitHubRefreshStartSchema.parse({ authorizeUrl: authorizeAt, expiresAt }));
};

const noInstallation = (installationId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such installation",
    detail: `your tenant holds no GitHub App installation ${installationId}`,
    fix: "List the installations with tumpel github list and pass an installationId it prints",
  });

const handleDelete = async (caller: Caller, env: Env, installationText: string): Promise<Response> => {
  const refused = ownerRequired(caller, "gitHubConnections.delete");
  if (refused) return refused;
  if (!/^[1-9][0-9]{0,15}$/.test(installationText)) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Not an installation id",
      detail: `${installationText} is not a GitHub installation id, which is a positive whole number`,
      fix: "List the installations with tumpel github list and pass an installationId it prints",
    });
  }
  if (!(await unlinkTenantInstallation(env.DB, caller.tenantId, Number(installationText)))) {
    return noInstallation(installationText);
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

const notConnected = (): Response =>
  problem(409, {
    code: "GitHubNotConnected",
    title: "GitHub not connected",
    detail: "your tenant holds no installation of the stage's GitHub App, so no repository is covered",
    fix: "Install it with tumpel github start and open the URL it prints",
  });

const unreadable = (detail: string): Response =>
  problem(409, {
    code: "RepositoryUnreadable",
    title: "GitHub refused the listing",
    detail,
    fix: "Check the repositories the installation covers on GitHub, then list again; see https://www.githubstatus.com if GitHub keeps failing",
  });

const listed = <T>(answer: GitHubAnswer<T[]>, schema: z.ZodType<T>): Response =>
  answer.ok ? json(answer.value.map((item) => schema.parse(item))) : unreadable(answer.detail);

type Access = { ok: true; app: AppKey; installations: GitHubInstallation[] } | { ok: false; response: Response };

const installationAccess = async (caller: Caller, url: URL, env: Env): Promise<Access> => {
  const app = await appKey(env.DB, keyStoreOf(env));
  if (app === null) return { ok: false, response: appMissing(url.origin) };
  const installations = await installationsOf(env.DB, caller.tenantId);
  if (installations.length === 0) return { ok: false, response: notConnected() };
  return { ok: true, app, installations };
};

const repositoriesOf = async (
  app: AppKey,
  env: Env,
  installation: GitHubInstallation,
): Promise<GitHubAnswer<z.infer<typeof GitHubRepositorySchema>[]>> => {
  const token = await mintInstallationWideToken(
    fetcher,
    env.GITHUB_API_ORIGIN,
    app,
    installation.installationId,
    Date.now(),
  );
  if (!token.ok) return { ...token, detail: `${token.detail}, for the installation on ${installation.accountLogin}` };
  return listInstallationRepositories(fetcher, env.GITHUB_API_ORIGIN, token.value);
};

const handleRepositories = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  const access = await installationAccess(caller, url, env);
  if (!access.ok) return access.response;
  const active = access.installations.filter((installation) => installation.status === "Active");
  const answers = await Promise.all(active.map((installation) => repositoriesOf(access.app, env, installation)));
  const refused = answers.find((answer) => !answer.ok);
  if (refused !== undefined && !refused.ok) return unreadable(refused.detail);
  return listed(
    { ok: true, value: answers.flatMap((answer) => (answer.ok ? answer.value : [])) },
    GitHubRepositorySchema,
  );
};

const handleIssues = async (caller: Caller, url: URL, env: Env, owner: string, name: string): Promise<Response> => {
  const path = GitHubRepositoryPathSchema.safeParse({ owner, name });
  if (!path.success) {
    return problem(404, {
      code: "NotFound",
      title: "No such repository",
      detail: `${owner}/${name} is not a GitHub repository name: ${issues(path.error)}`,
      fix: "List the repositories with tumpel github list-repositories and pass an owner and name it prints",
    });
  }
  const app = await appKey(env.DB, keyStoreOf(env));
  if (app === null) return appMissing(url.origin);
  const installation = await installationOn(env.DB, caller.tenantId, path.data.owner);
  const minted =
    installation === null
      ? uncovered(
          (await installationsOf(env.DB, caller.tenantId)).map(({ accountLogin }) => accountLogin),
          path.data,
        )
      : await mintInstallationToken(fetcher, env.GITHUB_API_ORIGIN, app, installation, path.data, Date.now());
  if (minted.kind === "NoToken") return notConnected();
  if (minted.kind !== "Minted") return unreadable(minted.detail);
  return listed(await listOpenIssues(fetcher, env.GITHUB_API_ORIGIN, minted.token, path.data), GitHubIssueSchema);
};

export const handleGitHubConnection = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const starting = url.pathname === START_PATH && request.method === "POST";
  const reading = url.pathname === CONNECTION_PATH && request.method === "GET";
  const deleting = request.method === "DELETE" ? INSTALLATION_PATH.exec(url.pathname) : null;
  const getting = request.method === "GET";
  const listing = getting && url.pathname === INSTALLATIONS_PATH;
  const accounts = getting && url.pathname === ACCOUNTS_PATH;
  const refreshing = url.pathname === REFRESH_PATH && request.method === "POST";
  const repositories = getting && url.pathname === REPOSITORIES_PATH;
  const issuesOf = getting ? ISSUES_PATH.exec(url.pathname) : null;
  const known = starting || reading || listing || accounts || refreshing || repositories;
  if (!known && deleting === null && issuesOf === null) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (deleting !== null) return handleDelete(caller, env, decodeURIComponent(deleting[1] ?? ""));
  if (listing) return handleList(caller, env);
  if (accounts) return handleListAccounts(caller, url, env);
  if (refreshing) return handleRefresh(caller, url, env);
  if (repositories) return handleRepositories(caller, url, env);
  if (issuesOf !== null) {
    return handleIssues(caller, url, env, decodeURIComponent(issuesOf[1] ?? ""), decodeURIComponent(issuesOf[2] ?? ""));
  }
  return starting ? handleStart(caller, url, env) : handleConnection(caller, url, env);
};

const appExists = (env: Env, url: URL, email: string, slug: string, htmlUrl: string): Response =>
  htmlPage(env, url, 409, (links) => appExistsPage(links, email, slug, htmlUrl));

const handleSetupPage = async (url: URL, env: Env, email: string): Promise<Response> => {
  const app = await storedApp(env.DB);
  if (app !== null) return appExists(env, url, email, app.slug, app.htmlUrl);
  const organization = url.searchParams.get("organization") ?? "";
  if (organization !== "" && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(organization)) {
    return htmlPage(env, url, 400, (links) => appBadOrganizationPage(links, email, organization));
  }
  const state = await signState(await stateKey(env), {
    purpose: "AppManifest",
    email,
    expiresAt: expiry(Date.now()),
  });
  const form = { manifest: appManifest(url.origin), action: manifestAction(organization, state), organization };
  return htmlPage(env, url, 200, (links) => appSetupPage(links, email, form));
};

const handleCreated = async (url: URL, env: Env, email: string): Promise<Response> => {
  const query = GitHubManifestCallbackSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return htmlPage(env, url, 400, (links) => appNothingToCreatePage(links, email));
  const state = await readState(await stateKey(env), query.data.state, GitHubManifestStateSchema, Date.now());
  if (!state.ok) return htmlPage(env, url, 403, (links) => appRequestRefusedPage(links, email, `${state.reason}.`));
  if (state.claims.email !== email) {
    const detail = `The App setup was started by ${state.claims.email}, and you are signed in as ${email}.`;
    return htmlPage(env, url, 403, (links) => appRequestRefusedPage(links, email, detail));
  }
  const existing = await storedApp(env.DB);
  if (existing !== null) return appExists(env, url, email, existing.slug, existing.htmlUrl);
  const converted = await convertManifest(fetcher, env.GITHUB_API_ORIGIN, query.data.code);
  if (!converted.ok) return htmlPage(env, url, 502, (links) => appGitHubRefusedPage(links, email, converted.detail));
  const bot = await botUserId(fetcher, env.GITHUB_API_ORIGIN, converted.value.slug, null);
  const stored = await storeApp(env.DB, keyStoreOf(env), converted.value, bot.ok ? bot.value : null, Date.now());
  if (stored.kind === "Exists") return appExists(env, url, email, stored.app.slug, stored.app.htmlUrl);
  return htmlPage(env, url, 200, (links) => appCreatedPage(links, email, stored.app.slug, stored.app.htmlUrl));
};

const refuseInstall = (
  env: Env,
  url: URL,
  email: string,
  tenantId: string | null,
  status: number,
  title: string,
  text: string,
): Response => htmlPage(env, url, status, (links) => installRefusedPage(links, email, tenantId, title, text));

const ownedTenants = async (env: Env, email: string): Promise<z.infer<typeof WhoamiSchema>[]> =>
  (await membershipsOfEmail(env.DB, email)).filter((membership) => membership.principal.role === "Owner");

const ownsTenant = async (env: Env, email: string, tenantId: string): Promise<boolean> =>
  (await ownedTenants(env, email)).some(({ tenant }) => tenant.tenantId === tenantId);

const linked = async (
  env: Env,
  url: URL,
  email: string,
  tenantId: string,
  record: GitHubInstallationRecord,
): Promise<Response> => {
  const outcome = await linkInstallation(env.DB, tenantId, record, Date.now());
  if (outcome.kind === "OtherTenant") {
    return htmlPage(env, url, 409, (links) =>
      installationInUsePage(links, email, tenantId, record.account.login, installationSettings(record.id)),
    );
  }
  const installation = {
    tenantId: outcome.installation.tenantId,
    accountLogin: outcome.installation.accountLogin,
    settingsUrl: installationSettings(record.id),
  };
  return htmlPage(env, url, 200, (links) => gitHubConnectedPage(links, email, installation));
};

const confirmInstallation = async (
  env: Env,
  url: URL,
  email: string,
  record: GitHubInstallationRecord,
): Promise<Response> => {
  const tenants = await ownedTenants(env, email);
  if (tenants.length === 0) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      403,
      "No tenant to connect",
      `${email} owns no tenant, and only an Owner connects GitHub. Ask an Owner of your tenant to connect ${record.account.login}.`,
    );
  }
  const choice = await signState(await stateKey(env), {
    purpose: "InstallationChoice",
    email,
    installation: record,
    expiresAt: expiry(Date.now()),
  });
  const request = {
    email,
    accountLogin: record.account.login,
    action: APP_INSTALLED_PATH,
    choice,
    tenants: tenants.map(({ tenant }) => ({ tenantId: tenant.tenantId, name: tenant.name })),
  };
  return htmlPage(env, url, 200, (links) => installationChoicePage(links, request));
};

const choiceOf = async (request: Request): Promise<Record<string, string>> => {
  const form = await request.formData().catch(() => new FormData());
  const fields: Record<string, string> = {};
  for (const [name, value] of form) if (typeof value === "string") fields[name] = value;
  return fields;
};

const handleChoice = async (request: Request, env: Env, url: URL, email: string): Promise<Response> => {
  const origin = request.headers.get("origin");
  if (origin !== url.origin) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      403,
      "Request refused",
      `The confirmation came from ${origin ?? "a page that sent no origin"}, and only this control plane's own confirmation page connects an installation.`,
    );
  }
  const picked = GitHubInstallationChoiceQuerySchema.safeParse(await choiceOf(request));
  if (!picked.success) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      400,
      "Nothing to connect",
      "The confirmation names no installation and tenant.",
    );
  }
  const state = await readState(
    await stateKey(env),
    picked.data.choice,
    GitHubInstallationChoiceStateSchema,
    Date.now(),
  );
  if (!state.ok)
    return refuseInstall(
      env,
      url,
      email,
      null,
      403,
      "Request refused",
      `The confirmation is no longer valid: ${state.reason}.`,
    );
  if (state.claims.email !== email) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      403,
      "Request refused",
      `The installation was confirmed for ${state.claims.email}, and you are signed in as ${email}.`,
    );
  }
  if (!(await ownsTenant(env, email, picked.data.tenant))) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      403,
      "Request refused",
      `${email} is no Owner of tenant ${picked.data.tenant}.`,
    );
  }
  return linked(env, url, email, picked.data.tenant, state.claims.installation);
};

type StartedBy = { ok: true; tenantId: string; returnUrl: string | undefined } | { ok: false; response: Response };

const startedBy = async (env: Env, url: URL, email: string, stateText: string): Promise<StartedBy> => {
  const state = await readState(await stateKey(env), stateText, GitHubInstallStateSchema, Date.now());
  if (!state.ok) {
    return {
      ok: false,
      response: refuseInstall(
        env,
        url,
        email,
        null,
        403,
        "Request refused",
        `The link from Tumpel is no longer valid: ${state.reason}.`,
      ),
    };
  }
  const { tenantId, returnUrl } = state.claims;
  if (state.claims.email !== email) {
    return {
      ok: false,
      response: refuseInstall(
        env,
        url,
        email,
        null,
        403,
        "Request refused",
        `This installation was started by ${state.claims.email}, and you are signed in as ${email}. Each person connects GitHub from their own Tumpel session.`,
      ),
    };
  }
  if (!(await ownsTenant(env, email, tenantId))) {
    return {
      ok: false,
      response: refuseInstall(
        env,
        url,
        email,
        null,
        403,
        "Request refused",
        `${email} is no longer an Owner of tenant ${tenantId}, and only an Owner connects GitHub.`,
      ),
    };
  }
  return { ok: true, tenantId, returnUrl };
};

type Verified = { ok: true; installation: GitHubInstallationRecord } | { ok: false; response: Response };

const verifiedInstaller = async (
  env: Env,
  url: URL,
  email: string,
  tenantId: string | null,
  code: string,
  installationId: number,
): Promise<Verified> => {
  const client = await oauthClient(env.DB, keyStoreOf(env));
  if (client === null) {
    return { ok: false, response: htmlPage(env, url, 409, (links) => noGitHubAppPage(links, email, tenantId)) };
  }
  const access = await verifyInstaller(
    fetcher,
    { api: env.GITHUB_API_ORIGIN, web: env.GITHUB_WEB_ORIGIN },
    client,
    code,
    installationId,
  );
  if (access.kind === "Failed") {
    return {
      ok: false,
      response: htmlPage(env, url, 502, (links) => installerUnconfirmedPage(links, email, tenantId, access.detail)),
    };
  }
  if (access.kind === "NotInstaller") {
    return {
      ok: false,
      response: htmlPage(env, url, 403, (links) => notTheInstallerPage(links, email, tenantId, access.detail)),
    };
  }
  const { user, installation } = access;
  const recorded: RecordedInstaller =
    installation.account.type === "User" ? { kind: "Unrecorded" } : await recordedInstaller(env.DB, installation.id);
  const installer = installedBy(user, installation, recorded);
  if (installer.kind === "InstallerUnknown") {
    return {
      ok: false,
      response: refuseInstall(
        env,
        url,
        email,
        tenantId,
        409,
        "GitHub has not named the installer yet",
        `${installer.detail}. GitHub sends that notice when the App is installed, sometimes a moment after you return here. An installation made before this control plane recorded installers has no such notice: uninstall the App on GitHub and install it again.`,
      ),
    };
  }
  if (installer.kind === "NotInstaller") {
    return {
      ok: false,
      response: htmlPage(env, url, 403, (links) => notTheInstallerPage(links, email, tenantId, installer.detail)),
    };
  }
  return { ok: true, installation: installer.installation };
};

type Outcome = { installation: GitHubInstallationRecord; decision: LinkDecision };
type Refreshed = { ok: true; outcomes: Map<number, Outcome> } | { ok: false; detail: string };

const linkedDecision = async (
  env: Env,
  tenantId: string,
  record: GitHubInstallationRecord,
  now: number,
): Promise<LinkDecision> => {
  const outcome = await linkInstallation(env.DB, tenantId, record, now);
  if (outcome.kind === "Linked") return { kind: "Link", installation: record };
  return {
    kind: "Unavailable",
    reason: "OtherTenant",
    detail: `another Tumpel tenant linked installation ${record.id} on ${record.account.login} a moment ago; disconnect it there, then refresh`,
  };
};

const refreshAccounts = async (env: Env, client: OAuthClient, tenantId: string, code: string): Promise<Refreshed> => {
  const origins = { api: env.GITHUB_API_ORIGIN, web: env.GITHUB_WEB_ORIGIN };
  const reading = await readAccounts(fetcher, origins, client, code);
  if (!reading.ok) return { ok: false, detail: reading.detail };
  const now = Date.now();
  const outcomes = new Map<number, Outcome>();
  for (const installation of reading.value.installations) {
    const decided = linkDecision(
      tenantId,
      await tenantOfInstallation(env.DB, installation.id),
      reading.value.user,
      installation,
      installation.account.type === "User" ? { kind: "Unrecorded" } : await recordedInstaller(env.DB, installation.id),
    );
    const decision = decided.kind === "Link" ? await linkedDecision(env, tenantId, installation, now) : decided;
    outcomes.set(installation.id, { installation, decision });
  }
  const tenant = env.TENANT.getByName(tenantId);
  const previous = await tenant.gitHubAccounts();
  const requested = new Set(
    (previous?.accounts ?? []).flatMap((account) =>
      account.standing === "Requested" ? [account.gitHubAccountId] : [],
    ),
  );
  const decisions = new Map([...outcomes].map(([installationId, { decision }]) => [installationId, decision]));
  await tenant.storeGitHubAccounts(accountRows(reading.value, decisions, requested), now);
  return { ok: true, outcomes };
};

const RETURN_PARAMETERS = ["from", "refused", "account", "failed"];

const backTo = (returnUrl: string, outcome: Record<string, string>): Response => {
  const target = new URL(returnUrl);
  for (const name of RETURN_PARAMETERS) target.searchParams.delete(name);
  target.searchParams.set("from", "github");
  for (const [name, value] of Object.entries(outcome)) target.searchParams.set(name, value);
  return seeOther(target.href);
};

const unavailablePage = (
  env: Env,
  url: URL,
  email: string,
  tenantId: string,
  installation: GitHubInstallationRecord,
  decision: Extract<LinkDecision, { kind: "Unavailable" }>,
): Response => {
  if (decision.reason === "OtherTenant") {
    return htmlPage(env, url, 409, (links) =>
      installationInUsePage(links, email, tenantId, installation.account.login, installationSettings(installation.id)),
    );
  }
  if (decision.reason === "NotInstaller") {
    return htmlPage(env, url, 403, (links) => notTheInstallerPage(links, email, tenantId, decision.detail));
  }
  return refuseInstall(
    env,
    url,
    email,
    tenantId,
    409,
    "GitHub has not named the installer yet",
    `${decision.detail}. GitHub sends that notice when the App is installed, sometimes a moment after you return here. An installation made before this control plane recorded installers has no such notice: uninstall the App on GitHub and install it again.`,
  );
};

const installReturn = async (
  env: Env,
  url: URL,
  email: string,
  started: { tenantId: string; returnUrl: string | undefined },
  code: string,
  installationId: number,
): Promise<Response> => {
  const { tenantId, returnUrl } = started;
  const client = await oauthClient(env.DB, keyStoreOf(env));
  if (client === null) return htmlPage(env, url, 409, (links) => noGitHubAppPage(links, email, tenantId));
  const refreshed = await refreshAccounts(env, client, tenantId, code);
  if (!refreshed.ok) {
    if (returnUrl !== undefined) return backTo(returnUrl, { failed: refreshed.detail });
    return htmlPage(env, url, 502, (links) => installerUnconfirmedPage(links, email, tenantId, refreshed.detail));
  }
  const outcome = refreshed.outcomes.get(installationId);
  if (outcome === undefined) {
    const detail = `installation ${installationId} is not among the installations of this stage's GitHub App that the GitHub account you authorized can access`;
    return htmlPage(env, url, 403, (links) => notTheInstallerPage(links, email, tenantId, detail));
  }
  const { installation, decision } = outcome;
  if (decision.kind === "Unavailable") {
    if (returnUrl !== undefined) {
      return backTo(returnUrl, { refused: decision.reason, account: installation.account.login });
    }
    return unavailablePage(env, url, email, tenantId, installation, decision);
  }
  if (returnUrl !== undefined) return backTo(returnUrl, {});
  const connected = {
    tenantId,
    accountLogin: installation.account.login,
    settingsUrl: installationSettings(installation.id),
  };
  return htmlPage(env, url, 200, (links) => gitHubConnectedPage(links, email, connected));
};

const accountsReturn = async (
  env: Env,
  url: URL,
  email: string,
  code: string,
  stateText: string,
): Promise<Response> => {
  const started = await startedBy(env, url, email, stateText);
  if (!started.ok) return started.response;
  const { tenantId } = started;
  const client = await oauthClient(env.DB, keyStoreOf(env));
  if (client === null) return htmlPage(env, url, 409, (links) => noGitHubAppPage(links, email, tenantId));
  const back = started.returnUrl ?? `${dashboardOrigin(env)}/t/${encodeURIComponent(tenantId)}/connections`;
  const refreshed = await refreshAccounts(env, client, tenantId, code);
  return backTo(back, refreshed.ok ? {} : { failed: refreshed.detail });
};

const askInstallerIdentity = async (env: Env, url: URL, email: string, installationId: number): Promise<Response> => {
  const client = await oauthClient(env.DB, keyStoreOf(env));
  if (client === null) return htmlPage(env, url, 409, (links) => noGitHubAppPage(links, email, null));
  const state = await signState(await stateKey(env), {
    purpose: "InstallerIdentity",
    email,
    installationId,
    expiresAt: expiry(Date.now()),
  });
  return seeOther(authorizeUrl(env.GITHUB_WEB_ORIGIN, client.clientId, `${url.origin}${APP_INSTALLED_PATH}`, state));
};

const handleInstallerIdentity = async (env: Env, url: URL, email: string): Promise<Response> => {
  const callback = GitHubInstallerIdentityCallbackSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!callback.success) return htmlPage(env, url, 400, (links) => installNothingToConnectPage(links, email));
  const state = await readState(
    await stateKey(env),
    callback.data.state,
    z.union([GitHubInstallStateSchema, GitHubInstallerIdentityStateSchema]),
    Date.now(),
  );
  if (!state.ok) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      403,
      "Request refused",
      `The GitHub sign-in for this installation is no longer valid: ${state.reason}.`,
    );
  }
  if (state.claims.purpose === "Installation") {
    return accountsReturn(env, url, email, callback.data.code, callback.data.state);
  }
  if (state.claims.email !== email) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      403,
      "Request refused",
      `The GitHub sign-in for this installation was started by ${state.claims.email}, and you are signed in as ${email}. Each person connects GitHub from their own Tumpel session.`,
    );
  }
  const verified = await verifiedInstaller(env, url, email, null, callback.data.code, state.claims.installationId);
  if (!verified.ok) return verified.response;
  return confirmInstallation(env, url, email, verified.installation);
};

const handleInstalled = async (env: Env, url: URL, email: string): Promise<Response> => {
  if (!url.searchParams.has("setup_action")) return handleInstallerIdentity(env, url, email);
  const query = Object.fromEntries(url.searchParams);
  const action = GitHubSetupActionSchema.safeParse(query);
  if (!action.success) {
    return htmlPage(env, url, 400, (links) => installNothingToConnectPage(links, email));
  }
  if (action.data.setup_action === "request") {
    const requested =
      action.data.state === undefined
        ? null
        : await readState(await stateKey(env), action.data.state, GitHubInstallStateSchema, Date.now());
    if (requested?.ok === true && requested.claims.email === email && requested.claims.gitHubAccountId !== undefined) {
      await env.TENANT.getByName(requested.claims.tenantId).markGitHubAccountRequested(
        requested.claims.gitHubAccountId,
      );
    }
    if (requested?.ok === true && requested.claims.returnUrl !== undefined)
      return backTo(requested.claims.returnUrl, {});
    const tenantId = requested?.ok === true ? requested.claims.tenantId : null;
    return htmlPage(env, url, 202, (links) => installationRequestedPage(links, email, tenantId));
  }
  const callback = GitHubSetupCallbackSchema.safeParse(query);
  if (!callback.success) {
    return refuseInstall(
      env,
      url,
      email,
      null,
      400,
      "Nothing to connect",
      "GitHub sent the installer back without an installation and a sign-in code. The App must request user authorization during installation; the stage operator turns that on in the App's settings on GitHub.",
    );
  }
  const { code, installation_id: installationText, state: stateText } = callback.data;
  const installationId = Number(installationText);
  if (stateText === undefined) return askInstallerIdentity(env, url, email, installationId);
  const started = await startedBy(env, url, email, stateText);
  if (!started.ok) return started.response;
  return installReturn(env, url, email, started, code, installationId);
};

export const handleGitHubPage = async (
  request: Request,
  url: URL,
  env: Env,
  signedIn: SignedInPerson,
): Promise<Response | null> => {
  const pages = [APP_SETUP_PATH, APP_CREATED_PATH, APP_INSTALLED_PATH];
  const confirming = request.method === "POST" && url.pathname === APP_INSTALLED_PATH;
  if (!confirming && (request.method !== "GET" || !pages.includes(url.pathname))) return null;
  const person = await signedIn(request, env);
  if (!person.ok) {
    return htmlPage(env, url, 401, (links) =>
      signInAgainPage(links, person.reason, confirming ? `${links.dashboard}/connections` : url.href),
    );
  }
  if (confirming) return handleChoice(request, env, url, person.email);
  if (url.pathname === APP_SETUP_PATH) return handleSetupPage(url, env, person.email);
  if (url.pathname === APP_CREATED_PATH) return handleCreated(url, env, person.email);
  return handleInstalled(env, url, person.email);
};

const handleWorkflowRun = async (env: Env, body: ArrayBuffer, noContent: Response): Promise<Response> => {
  const delivery = GitHubWorkflowRunEventSchema.safeParse(parseJson(new TextDecoder().decode(body)));
  if (!delivery.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Not a workflow_run event",
      detail: `the workflow_run delivery does not parse: ${issues(delivery.error)}`,
      fix: "Send workflow_run events in the shape GitHub documents, with an action, an installation and a workflow_run",
    });
  }
  const { action, installation, workflow_run: run } = delivery.data;
  const tenantId = await tenantOfInstallation(env.DB, installation.id);
  if (tenantId === null) return noContent;
  await env.TENANT.getByName(tenantId).workflowRunReported(
    tenantId,
    { action, runId: run.id, headSha: run.head_sha, htmlUrl: run.html_url, conclusion: run.conclusion },
    Date.now(),
  );
  return noContent;
};

export const handleGitHubWebhook = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  if (request.method !== "POST" || url.pathname !== WEBHOOK_PATH) return null;
  const secret = await webhookSecret(env.DB, keyStoreOf(env));
  if (secret === null) {
    return problem(404, {
      code: "NotFound",
      title: "No GitHub App",
      detail: "this stage has no GitHub App, so no webhook delivery belongs to it",
      fix: `Create the App at ${url.origin}${APP_SETUP_PATH}, or remove this webhook on GitHub`,
    });
  }
  const body = await request.arrayBuffer();
  if (!(await verifyWebhookSignature(secret, body, request.headers.get("x-hub-signature-256")))) {
    return problem(403, {
      code: "Forbidden",
      title: "Signature mismatch",
      detail: "X-Hub-Signature-256 is missing or does not match the body under the App's webhook secret",
      fix: "Send deliveries from the stage's GitHub App, whose webhook secret the control plane stored at creation",
    });
  }
  const noContent = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const event = request.headers.get("x-github-event");
  if (event === "workflow_run") return handleWorkflowRun(env, body, noContent);
  if (event !== "installation") return noContent;
  const delivery = GitHubInstallationEventSchema.safeParse(parseJson(new TextDecoder().decode(body)));
  if (!delivery.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Not an installation event",
      detail: `the installation delivery does not parse: ${issues(delivery.error)}`,
      fix: "Send installation events in the shape GitHub documents, with an action, an installation and a sender",
    });
  }
  const { action, installation, sender } = delivery.data;
  if (action === "deleted") {
    await unlinkInstallation(env.DB, installation.id);
    return noContent;
  }
  const now = Date.now();
  if (action === "created" || action === "new_permissions_accepted") {
    await recordInstaller(env.DB, installation.id, sender.id);
  }
  await refreshInstallation(env.DB, installation, now);
  if (action === "suspend") await setInstallationStatus(env.DB, installation.id, "Suspended", now);
  if (action === "unsuspend") await setInstallationStatus(env.DB, installation.id, "Active", now);
  return noContent;
};
