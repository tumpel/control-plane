import {
  GitHubConnectionSchema,
  GitHubInstallStartSchema,
  GitHubInstallStateSchema,
  GitHubManifestCallbackSchema,
  GitHubManifestStateSchema,
  GitHubSetupCallbackSchema,
  GitHubWebhookDeliverySchema,
} from "@tumpel/api/schemas";
import {
  APP_CREATED_PATH,
  APP_INSTALLED_PATH,
  APP_SETUP_PATH,
  appManifest,
  convertManifest,
  type Fetch,
  GITHUB_WEB,
  installUrl,
  manifestAction,
  readInstallation,
  readState,
  STATE_KEY_PURPOSE,
  STATE_TTL_MS,
  signState,
  verifyWebhookSignature,
  WEBHOOK_PATH,
} from "./github.ts";
import {
  appCredentials,
  installationOf,
  linkInstallation,
  storeApp,
  storedApp,
  unlinkInstallation,
} from "./github-store.ts";
import { json, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { appSetupPage, linkPage, messagePage } from "./pages";

export type PersonCheck = { ok: true; email: string } | { ok: false; reason: string };
export type SignedInPerson = (request: Request, env: Env) => Promise<PersonCheck>;
export type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const START_PATH = "/v1/github-connection/start";
const CONNECTION_PATH = "/v1/github-connection";
const fetcher: Fetch = (url, init) => fetch(url, init);
const stateKey = (env: Env): Promise<CryptoKey> => keyStoreOf(env).signingKey(STATE_KEY_PURPOSE);
const expiry = (now: number): string => new Date(now + STATE_TTL_MS).toISOString();

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
  const app = await storedApp(env.DB);
  if (app === null) return appMissing(url.origin);
  const expiresAt = expiry(Date.now());
  const state = await signState(await stateKey(env), {
    purpose: "Installation",
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    expiresAt,
  });
  return json(GitHubInstallStartSchema.parse({ installUrl: installUrl(app.slug, state), expiresAt }));
};

export const handleGitHubConnection = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const starting = url.pathname === START_PATH && request.method === "POST";
  const reading = url.pathname === CONNECTION_PATH && request.method === "GET";
  if (!starting && !reading) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
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
  const converted = await convertManifest(fetcher, query.data.code);
  if (!converted.ok) {
    return messagePage(
      502,
      "GitHub refused the App",
      `${converted.detail}. A conversion code works once and for an hour; start again at ${APP_SETUP_PATH}.`,
    );
  }
  const stored = await storeApp(env.DB, keyStoreOf(env), converted.value, Date.now());
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
  const query = GitHubSetupCallbackSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    return messagePage(400, "Nothing to connect", "GitHub sent no setup action. Run tumpel github start again.");
  }
  const { installation_id: installationText, setup_action: action, state: stateText } = query.data;
  if (action === "request") {
    return messagePage(
      202,
      "Installation requested",
      "An owner of the GitHub organization must approve the installation. Once approved, run tumpel github start again and finish it from the URL it prints.",
    );
  }
  if (installationText === undefined || stateText === undefined) {
    return messagePage(
      400,
      "Nothing to connect",
      "GitHub sent no installation or no state; this happens when the App is installed from GitHub instead of from tumpel. Run tumpel github start and open the URL it prints.",
    );
  }
  const state = await readState(await stateKey(env), stateText, GitHubInstallStateSchema, Date.now());
  if (!state.ok) return messagePage(403, "Request refused", `${state.reason}. Run tumpel github start again.`);
  const app = await appCredentials(env.DB, keyStoreOf(env));
  if (app === null)
    return messagePage(409, "No GitHub App", `This stage has no GitHub App; create it at ${APP_SETUP_PATH}.`);
  const installationId = Number(installationText);
  const record = await readInstallation(fetcher, app, installationId, Date.now());
  if (!record.ok) {
    return messagePage(
      502,
      "Installation not found",
      `${record.detail}. Install the App again from the URL tumpel github start prints.`,
    );
  }
  const linked = await linkInstallation(env.DB, state.claims.tenantId, record.value, Date.now());
  if (linked.kind === "OtherTenant") {
    return messagePage(
      409,
      "Installation in use",
      `The installation on ${record.value.account.login} is linked to another tenant. Each installation serves one tenant; uninstall it there first.`,
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

const DROPPING_ACTIONS = ["deleted", "suspend"];

export const handleGitHubWebhook = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  if (request.method !== "POST" || url.pathname !== WEBHOOK_PATH) return null;
  const app = await appCredentials(env.DB, keyStoreOf(env));
  if (app === null) {
    return problem(404, {
      code: "NotFound",
      title: "No GitHub App",
      detail: "this stage has no GitHub App, so no webhook delivery belongs to it",
      fix: `Create the App at ${url.origin}${APP_SETUP_PATH}, or remove this webhook on GitHub`,
    });
  }
  const body = await request.text();
  if (!(await verifyWebhookSignature(app.webhookSecret, body, request.headers.get("x-hub-signature-256")))) {
    return problem(403, {
      code: "Forbidden",
      title: "Signature mismatch",
      detail: "X-Hub-Signature-256 is missing or does not match the body under the App's webhook secret",
      fix: "Send deliveries from the stage's GitHub App, whose webhook secret the control plane stored at creation",
    });
  }
  const noContent = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (request.headers.get("x-github-event") !== "installation") return noContent;
  const delivery = GitHubWebhookDeliverySchema.safeParse(JSON.parse(body));
  if (!delivery.success || delivery.data.installation === undefined) return noContent;
  if (DROPPING_ACTIONS.includes(delivery.data.action ?? "")) {
    await unlinkInstallation(env.DB, delivery.data.installation.id);
  }
  return noContent;
};
