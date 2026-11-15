import {
  GitHubConnectionSchema,
  GitHubInstallStartSchema,
  GitHubIssueSchema,
  GitHubRepositoryPathSchema,
  GitHubRepositorySchema,
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
  type Fetch,
  GITHUB_WEB,
  type GitHubAnswer,
  type Installation,
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
  GitHubInstallationEventSchema,
  GitHubInstallStateSchema,
  GitHubManifestCallbackSchema,
  GitHubManifestStateSchema,
  GitHubSetupActionSchema,
  GitHubSetupCallbackSchema,
  GitHubWorkflowRunEventSchema,
} from "./github-schemas.ts";
import {
  appKey,
  installationOf,
  linkInstallation,
  oauthClient,
  storeApp,
  storedApp,
  tenantOfInstallation,
  unlinkInstallation,
  unlinkTenant,
  webhookSecret,
} from "./github-store.ts";
import { json, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { ownerRequired } from "./members";
import { appSetupPage, linkPage, messagePage } from "./pages";

export type PersonCheck = { ok: true; email: string } | { ok: false; reason: string };
export type SignedInPerson = (request: Request, env: Env) => Promise<PersonCheck>;
export type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const START_PATH = "/v1/github-connection/start";
const CONNECTION_PATH = "/v1/github-connection";
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
        link: { state: "AppMissing", setupUrl: `${url.origin}${APP_SETUP_PATH}` },
      }),
    );
  }
  const installation = await installationOf(env.DB, caller.tenantId);
  return json(
    GitHubConnectionSchema.parse({
      tenantId: caller.tenantId,
      link: installation === null ? { state: "NotConnected", appSlug: app.slug } : { state: "Connected", installation },
    }),
  );
};

const handleStart = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  const refused = ownerRequired(caller, "gitHubConnections.start");
  if (refused) return refused;
  const app = await storedApp(env.DB);
  if (app === null) return appMissing(url.origin);
  const expiresAt = expiry(Date.now());
  const state = await signState(await stateKey(env), {
    purpose: "Installation",
    tenantId: caller.tenantId,
    expiresAt,
  });
  return json(GitHubInstallStartSchema.parse({ installUrl: installUrl(app.slug, state), expiresAt }));
};

const handleDelete = async (caller: Caller, env: Env): Promise<Response> => {
  const refused = ownerRequired(caller, "gitHubConnections.delete");
  if (refused) return refused;
  await unlinkTenant(env.DB, caller.tenantId);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

const notConnected = (): Response =>
  problem(409, {
    code: "GitHubNotConnected",
    title: "GitHub not connected",
    detail: "your tenant has not installed the stage's GitHub App, so no repository is covered",
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

type Access = { ok: true; app: AppKey; installation: Installation } | { ok: false; response: Response };

const installationAccess = async (caller: Caller, url: URL, env: Env): Promise<Access> => {
  const app = await appKey(env.DB, keyStoreOf(env));
  if (app === null) return { ok: false, response: appMissing(url.origin) };
  const installation = await installationOf(env.DB, caller.tenantId);
  if (installation === null) return { ok: false, response: notConnected() };
  return { ok: true, app, installation };
};

const handleRepositories = async (caller: Caller, url: URL, env: Env): Promise<Response> => {
  const access = await installationAccess(caller, url, env);
  if (!access.ok) return access.response;
  const token = await mintInstallationWideToken(
    fetcher,
    env.GITHUB_API_ORIGIN,
    access.app,
    access.installation.installationId,
    Date.now(),
  );
  if (!token.ok) return unreadable(token.detail);
  return listed(
    await listInstallationRepositories(fetcher, env.GITHUB_API_ORIGIN, token.value),
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
    access.installation,
    path.data,
    Date.now(),
  );
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
  const deleting = url.pathname === CONNECTION_PATH && request.method === "DELETE";
  const getting = request.method === "GET";
  const repositories = getting && url.pathname === REPOSITORIES_PATH;
  const issuesOf = getting ? ISSUES_PATH.exec(url.pathname) : null;
  if (!starting && !reading && !deleting && !repositories && issuesOf === null) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (deleting) return handleDelete(caller, env);
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

const handleInstalled = async (url: URL, env: Env): Promise<Response> => {
  const query = Object.fromEntries(url.searchParams);
  const action = GitHubSetupActionSchema.safeParse(query);
  if (!action.success) {
    return messagePage(400, "Nothing to connect", "GitHub sent no setup action. Run tumpel github start again.");
  }
  if (action.data.setup_action === "request") {
    return messagePage(
      202,
      "Installation requested",
      "An owner of the GitHub organization must approve the installation. Once approved, run tumpel github start again and finish it from the URL it prints.",
    );
  }
  const callback = GitHubSetupCallbackSchema.safeParse(query);
  if (!callback.success) {
    return messagePage(
      400,
      "Nothing to connect",
      `GitHub sent the installer back without ${issues(callback.error)}; this happens when the App is installed from GitHub instead of from tumpel. Run tumpel github start and open the URL it prints.`,
    );
  }
  const { code, installation_id: installationText, state: stateText } = callback.data;
  const state = await readState(await stateKey(env), stateText, GitHubInstallStateSchema, Date.now());
  if (!state.ok) return messagePage(403, "Request refused", `${state.reason}. Run tumpel github start again.`);
  const client = await oauthClient(env.DB, keyStoreOf(env));
  if (client === null)
    return messagePage(409, "No GitHub App", `This stage has no GitHub App; create it at ${APP_SETUP_PATH}.`);
  const installationId = Number(installationText);
  const installer = await verifyInstaller(fetcher, env.GITHUB_API_ORIGIN, client, code, installationId);
  if (installer.kind === "Failed") {
    return messagePage(
      502,
      "GitHub did not confirm the installer",
      `${installer.detail}. Run tumpel github start again.`,
    );
  }
  if (installer.kind === "NotInstaller") {
    return messagePage(
      403,
      "Request refused",
      `${installer.detail}. Sign in to GitHub as a person who installed the App, then run tumpel github start again.`,
    );
  }
  const record = installer.installation;
  const linked = await linkInstallation(env.DB, state.claims.tenantId, record, Date.now());
  if (linked.kind === "OtherTenant") {
    return messagePage(
      409,
      "Installation in use",
      `The installation on ${record.account.login} is linked to another tenant. Each installation serves one tenant; uninstall it there first.`,
    );
  }
  return linkPage(
    200,
    "GitHub connected",
    `Tenant ${linked.installation.tenantId} now uses the GitHub App installation on ${linked.installation.accountLogin}. Each turn on a repository of ${linked.installation.accountLogin} gets a token of its own.`,
    `${GITHUB_WEB}/settings/installations/${installationId}`,
    "Choose the repositories it covers on GitHub",
  );
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
  if (!person.ok) return messagePage(401, "Sign in again", `${person.reason}.`);
  if (url.pathname === APP_SETUP_PATH) return handleSetupPage(url, env, person.email);
  if (url.pathname === APP_CREATED_PATH) return handleCreated(url, env, person.email);
  return handleInstalled(url, env);
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
      fix: "Send installation events in the shape GitHub documents, with an action and an installation",
    });
  }
  if (delivery.data.action === "deleted") await unlinkInstallation(env.DB, delivery.data.installation.id);
  return noContent;
};
