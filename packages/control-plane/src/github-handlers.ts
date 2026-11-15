import {
  GitHubConnectionSchema,
  GitHubInstallationPathSchema,
  GitHubInstallationSchema,
  GitHubInstallStartSchema,
  GitHubIssueSchema,
  GitHubRepositoryPathSchema,
  GitHubRepositorySchema,
  type WhoamiSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import {
  APP_CREATED_PATH,
  APP_INSTALLED_PATH,
  APP_SETUP_PATH,
  type AppKey,
  appManifest,
  botUserId,
  convertManifest,
  dashboardReturn,
  type Fetch,
  GITHUB_WEB,
  type GitHubAnswer,
  type GitHubInstallationRecord,
  installUrl,
  listInstallationRepositories,
  listOpenIssues,
  manifestAction,
  mintInstallationToken,
  mintInstallationWideToken,
  parseJson,
  readState,
  STATE_KEY_PURPOSE,
  STATE_TTL_MS,
  signState,
  verifyInstaller,
  verifyWebhookSignature,
  WEBHOOK_PATH,
} from "./github.ts";
import {
  GitHubInstallationChoiceQuerySchema,
  GitHubInstallationChoiceStateSchema,
  GitHubInstallationEventSchema,
  GitHubInstallationRepositoriesEventSchema,
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
  installationsOf,
  linkInstallation,
  oauthClient,
  refreshInstallation,
  storeApp,
  storedApp,
  tenantOfInstallation,
  unlinkInstallation,
  unlinkTenantInstallation,
  webhookSecret,
} from "./github-store.ts";
import { json, problem, seeOther } from "./http";
import { type Caller, membershipsOfEmail } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { ownerRequired } from "./members";
import { appSetupPage, connectAgainPage, installationTenantPage, linkPage, messagePage } from "./pages";

export type PersonCheck = { ok: true; email: string } | { ok: false; reason: string };
export type SignedInPerson = (request: Request, env: Env) => Promise<PersonCheck>;
export type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const START_PATH = "/v1/github-connection/start";
const CONNECTION_PATH = "/v1/github-connection";
const INSTALLATIONS_PATH = "/v1/github-connection/installations";
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

const handleStart = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  const refused = ownerRequired(caller, "gitHubConnections.start");
  if (refused) return refused;
  const back = dashboardReturn(url.searchParams.get("returnUrl"), env.DASHBOARD_ORIGIN);
  if (!back.ok) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Return URL refused",
      detail: `gitHubConnections.start refused the return URL: ${back.detail}`,
      fix: `Leave returnUrl out, or name a page on ${env.DASHBOARD_ORIGIN || "the dashboard"}`,
    });
  }
  const app = await storedApp(env.DB);
  if (app === null) return appMissing(url.origin);
  const expiresAt = expiry(Date.now());
  const state = await signState(await stateKey(env), {
    purpose: "Installation",
    tenantId: caller.tenantId,
    expiresAt,
    ...(back.returnUrl === undefined ? {} : { returnUrl: back.returnUrl }),
  });
  return json(GitHubInstallStartSchema.parse({ installUrl: installUrl(app.slug, state), expiresAt }));
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
  const path = GitHubInstallationPathSchema.safeParse({
    installationId: /^[1-9][0-9]{0,15}$/.test(installationText) ? Number(installationText) : null,
  });
  if (!path.success) return noInstallation(installationText);
  if (!(await unlinkTenantInstallation(env.DB, caller.tenantId, path.data.installationId))) {
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
  const access = await installationAccess(caller, url, env);
  if (!access.ok) return access.response;
  const minted = await mintInstallationToken(
    fetcher,
    env.GITHUB_API_ORIGIN,
    access.app,
    access.installations,
    path.data,
    Date.now(),
  );
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
  const repositories = getting && url.pathname === REPOSITORIES_PATH;
  const issuesOf = getting ? ISSUES_PATH.exec(url.pathname) : null;
  if (!starting && !reading && deleting === null && !listing && !repositories && issuesOf === null) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (deleting !== null) return handleDelete(caller, env, decodeURIComponent(deleting[1] ?? ""));
  if (listing) return handleList(caller, env);
  if (repositories) return handleRepositories(caller, url, env);
  if (issuesOf !== null) {
    return handleIssues(caller, url, env, decodeURIComponent(issuesOf[1] ?? ""), decodeURIComponent(issuesOf[2] ?? ""));
  }
  return starting ? handleStart(caller, url, env) : handleConnection(caller, url, env);
};

const appExists = (slug: string, htmlUrl: string): Response =>
  linkPage(
    409,
    "GitHub App already set up",
    `This stage already has the GitHub App ${slug}; it is created once per stage. Install it for a tenant with tumpel github start.`,
    htmlUrl,
    `Open ${slug} on GitHub`,
  );

const handleSetupPage = async (url: URL, env: Env, email: string): Promise<Response> => {
  const app = await storedApp(env.DB);
  if (app !== null) return appExists(app.slug, app.htmlUrl);
  const organization = url.searchParams.get("organization") ?? "";
  if (organization !== "" && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(organization)) {
    return messagePage(400, "Not an organization", `${organization} is not a GitHub organization login.`);
  }
  const state = await signState(await stateKey(env), {
    purpose: "AppManifest",
    email,
    expiresAt: expiry(Date.now()),
  });
  return appSetupPage(
    email,
    appManifest(url.origin),
    manifestAction(organization, state),
    organization === "" ? "your GitHub account" : `the organization ${organization}`,
  );
};

const handleCreated = async (url: URL, env: Env, email: string): Promise<Response> => {
  const query = GitHubManifestCallbackSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    return messagePage(400, "Nothing to create", `GitHub sent no code and state. Start again at ${APP_SETUP_PATH}.`);
  }
  const state = await readState(await stateKey(env), query.data.state, GitHubManifestStateSchema, Date.now());
  if (!state.ok) return messagePage(403, "Request refused", `${state.reason}. Start again at ${APP_SETUP_PATH}.`);
  if (state.claims.email !== email) {
    return messagePage(
      403,
      "Request refused",
      `The App setup was started by ${state.claims.email}, and you are signed in as ${email}. Start again at ${APP_SETUP_PATH}.`,
    );
  }
  const existing = await storedApp(env.DB);
  if (existing !== null) return appExists(existing.slug, existing.htmlUrl);
  const converted = await convertManifest(fetcher, env.GITHUB_API_ORIGIN, query.data.code);
  if (!converted.ok) {
    return messagePage(
      502,
      "GitHub refused the App",
      `${converted.detail}. A conversion code works once and for an hour; start again at ${APP_SETUP_PATH}.`,
    );
  }
  const bot = await botUserId(fetcher, env.GITHUB_API_ORIGIN, converted.value.slug, null);
  const stored = await storeApp(env.DB, keyStoreOf(env), converted.value, bot.ok ? bot.value : null, Date.now());
  if (stored.kind === "Exists") return appExists(stored.app.slug, stored.app.htmlUrl);
  return linkPage(
    200,
    "GitHub App created",
    `Created the GitHub App ${stored.app.slug} for this stage. Each tenant installs it once: run tumpel github start and open the URL it prints.`,
    stored.app.htmlUrl,
    `Open ${stored.app.slug} on GitHub`,
  );
};

const connectUrl = (env: Env, tenantId: string | null): string =>
  tenantId === null
    ? `${env.DASHBOARD_ORIGIN}/`
    : `${env.DASHBOARD_ORIGIN}/t/${encodeURIComponent(tenantId)}/setup/github`;

const refuseInstall = (env: Env, tenantId: string | null, status: number, title: string, text: string): Response =>
  connectAgainPage(
    status,
    title,
    `${text} Choose Connect from Tumpel to start again from the dashboard's GitHub step, or run tumpel github start on the CLI.`,
    connectUrl(env, tenantId),
  );

const ownedTenants = async (env: Env, email: string): Promise<z.infer<typeof WhoamiSchema>[]> =>
  (await membershipsOfEmail(env.DB, email)).filter((membership) => membership.principal.role === "Owner");

const linked = async (
  env: Env,
  tenantId: string,
  record: GitHubInstallationRecord,
  returnUrl: string | undefined,
): Promise<Response> => {
  const outcome = await linkInstallation(env.DB, tenantId, record, Date.now());
  if (outcome.kind === "OtherTenant") {
    return refuseInstall(
      env,
      tenantId,
      409,
      "Installation in use",
      `The installation on ${record.account.login} is linked to another tenant. Each installation serves one tenant; remove it there first.`,
    );
  }
  if (returnUrl !== undefined) return seeOther(returnUrl);
  return linkPage(
    200,
    "GitHub connected",
    `Tenant ${outcome.installation.tenantId} now holds the GitHub App installation on ${outcome.installation.accountLogin}, next to any it held before. Each turn on a repository of ${outcome.installation.accountLogin} gets a token of its own. Connect another account or organization from the dashboard's GitHub connection, or with tumpel github start.`,
    `${GITHUB_WEB}/settings/installations/${record.id}`,
    "Choose the repositories it covers on GitHub",
  );
};

const chooseTenant = async (url: URL, env: Env, email: string, record: GitHubInstallationRecord): Promise<Response> => {
  const tenants = await ownedTenants(env, email);
  const [only, ...others] = tenants;
  if (only === undefined) {
    return refuseInstall(
      env,
      null,
      403,
      "No tenant to connect",
      `${email} owns no tenant, and only an Owner connects GitHub. Ask an Owner of your tenant to connect ${record.account.login}.`,
    );
  }
  if (others.length === 0) return linked(env, only.tenant.tenantId, record, undefined);
  const choice = await signState(await stateKey(env), {
    purpose: "InstallationChoice",
    email,
    installation: record,
    expiresAt: expiry(Date.now()),
  });
  return installationTenantPage(
    email,
    record.account.login,
    tenants.map(({ tenant }) => {
      const href = new URL(APP_INSTALLED_PATH, url.origin);
      href.searchParams.set("choice", choice);
      href.searchParams.set("tenant", tenant.tenantId);
      return { name: tenant.name, href: href.toString() };
    }),
  );
};

const handleChoice = async (env: Env, email: string, query: Record<string, string>): Promise<Response> => {
  const picked = GitHubInstallationChoiceQuerySchema.safeParse(query);
  if (!picked.success) {
    return refuseInstall(env, null, 400, "Nothing to connect", "The tenant choice is missing from the link.");
  }
  const state = await readState(
    await stateKey(env),
    picked.data.choice,
    GitHubInstallationChoiceStateSchema,
    Date.now(),
  );
  if (!state.ok)
    return refuseInstall(env, null, 403, "Request refused", `The tenant choice is no longer valid: ${state.reason}.`);
  if (state.claims.email !== email) {
    return refuseInstall(
      env,
      null,
      403,
      "Request refused",
      `The installation was confirmed for ${state.claims.email}, and you are signed in as ${email}.`,
    );
  }
  const owned = await ownedTenants(env, email);
  if (!owned.some(({ tenant }) => tenant.tenantId === picked.data.tenant)) {
    return refuseInstall(env, null, 403, "Request refused", `${email} is no Owner of tenant ${picked.data.tenant}.`);
  }
  return linked(env, picked.data.tenant, state.claims.installation, undefined);
};

const handleInstalled = async (url: URL, env: Env, email: string): Promise<Response> => {
  const query = Object.fromEntries(url.searchParams);
  if (query.choice !== undefined) return handleChoice(env, email, query);
  const action = GitHubSetupActionSchema.safeParse(query);
  if (!action.success) {
    return refuseInstall(env, null, 400, "Nothing to connect", "GitHub sent no setup action with this link.");
  }
  if (action.data.setup_action === "request") {
    const requested =
      action.data.state === undefined
        ? null
        : await readState(await stateKey(env), action.data.state, GitHubInstallStateSchema, Date.now());
    if (requested?.ok === true && requested.claims.returnUrl !== undefined) return seeOther(requested.claims.returnUrl);
    return connectAgainPage(
      202,
      "Installation requested",
      "An owner of the GitHub organization must approve the installation. Once approved, connect again from Tumpel and finish it, or run tumpel github start on the CLI.",
      connectUrl(env, requested?.ok === true ? requested.claims.tenantId : null),
    );
  }
  const callback = GitHubSetupCallbackSchema.safeParse(query);
  if (!callback.success) {
    return refuseInstall(
      env,
      null,
      400,
      "Nothing to connect",
      "GitHub sent the installer back without an installation and a sign-in code. The App must request user authorization during installation; the stage operator turns that on in the App's settings on GitHub.",
    );
  }
  const { code, installation_id: installationText, state: stateText } = callback.data;
  const state =
    stateText === undefined
      ? null
      : await readState(await stateKey(env), stateText, GitHubInstallStateSchema, Date.now());
  if (state !== null && !state.ok) {
    return refuseInstall(
      env,
      null,
      403,
      "Request refused",
      `The link from Tumpel is no longer valid: ${state.reason}.`,
    );
  }
  const client = await oauthClient(env.DB, keyStoreOf(env));
  if (client === null) {
    return messagePage(409, "No GitHub App", `This stage has no GitHub App; create it at ${APP_SETUP_PATH}.`);
  }
  const tenantId = state?.claims.tenantId ?? null;
  const installationId = Number(installationText);
  const installer = await verifyInstaller(fetcher, env.GITHUB_API_ORIGIN, client, code, installationId);
  if (installer.kind === "Failed") {
    return refuseInstall(env, tenantId, 502, "GitHub did not confirm the installer", `${installer.detail}.`);
  }
  if (installer.kind === "NotInstaller") {
    return refuseInstall(
      env,
      tenantId,
      403,
      "Request refused",
      `${installer.detail}. Sign in to GitHub as a person who can access the installation.`,
    );
  }
  if (state !== null) return linked(env, state.claims.tenantId, installer.installation, state.claims.returnUrl);
  return chooseTenant(url, env, email, installer.installation);
};

export const handleGitHubPage = async (
  request: Request,
  url: URL,
  env: Env,
  signedIn: SignedInPerson,
): Promise<Response | null> => {
  const pages = [APP_SETUP_PATH, APP_CREATED_PATH, APP_INSTALLED_PATH];
  if (request.method !== "GET" || !pages.includes(url.pathname)) return null;
  const person = await signedIn(request, env);
  if (!person.ok) {
    return linkPage(
      401,
      "Sign in again",
      `${person.reason}. Sign in, then this page continues.`,
      url.toString(),
      "Sign in and continue",
    );
  }
  if (url.pathname === APP_SETUP_PATH) return handleSetupPage(url, env, person.email);
  if (url.pathname === APP_CREATED_PATH) return handleCreated(url, env, person.email);
  return handleInstalled(url, env, person.email);
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

const handleInstallationRepositories = async (env: Env, body: ArrayBuffer, noContent: Response): Promise<Response> => {
  const delivery = GitHubInstallationRepositoriesEventSchema.safeParse(parseJson(new TextDecoder().decode(body)));
  if (!delivery.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Not an installation_repositories event",
      detail: `the installation_repositories delivery does not parse: ${issues(delivery.error)}`,
      fix: "Send installation_repositories events in the shape GitHub documents, with an installation and a repository_selection",
    });
  }
  const { installation, repository_selection: selection } = delivery.data;
  await refreshInstallation(env.DB, installation, selection, null, Date.now());
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
  if (event === "installation_repositories") return handleInstallationRepositories(env, body, noContent);
  if (event !== "installation") return noContent;
  const delivery = GitHubInstallationEventSchema.safeParse(parseJson(new TextDecoder().decode(body)));
  if (!delivery.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Not an installation event",
      detail: `the installation delivery does not parse: ${issues(delivery.error)}`,
      fix: "Send installation events in the shape GitHub documents, with an action and an installation",
    });
  }
  const { action, installation } = delivery.data;
  if (action === "deleted") {
    await unlinkInstallation(env.DB, installation.id);
    return noContent;
  }
  const status = action === "suspend" ? "Suspended" : action === "unsuspend" ? "Active" : null;
  await refreshInstallation(env.DB, installation, installation.repository_selection, status, Date.now());
  return noContent;
};
