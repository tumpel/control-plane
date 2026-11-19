import {
  PrebuildTemplateManifestSchema,
  PrebuildTemplatePullRequestOpenSchema,
  PrebuildTemplatePullRequestQuerySchema,
} from "@tumpel/schemas";
import npmDevcontainer1 from "../templates/npm/1/devcontainer.jsonc";
import npmManifest1 from "../templates/npm/1/template.json";
import pythonDevcontainer1 from "../templates/python/1/devcontainer.jsonc";
import pythonManifest1 from "../templates/python/1/template.json";
import rustDevcontainer1 from "../templates/rust/1/devcontainer.jsonc";
import rustManifest1 from "../templates/rust/1/template.json";
import recordedVersions from "../templates/versions.json";
import {
  type GitHubRepository,
  githubRepository,
  mintInstallationWideToken,
  notARepository,
  type Permissions,
} from "./github.ts";
import { appMissing } from "./github-handlers.ts";
import { appKey, installationOn } from "./github-store.ts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import {
  catalog,
  findVersion,
  type PrebuildTemplateVersion,
  RecordedVersionsSchema,
  type VersionLookup,
} from "./template-catalog.ts";
import { openTemplatePullRequest, readTemplatePullRequest } from "./template-pull-request.ts";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const FILES: Record<string, { devcontainer: string; manifest: unknown }> = {
  "npm/1": { devcontainer: npmDevcontainer1, manifest: npmManifest1 },
  "python/1": { devcontainer: pythonDevcontainer1, manifest: pythonManifest1 },
  "rust/1": { devcontainer: rustDevcontainer1, manifest: rustManifest1 },
};

const shippedVersion = (recorded: {
  prebuildTemplateId: string;
  prebuildTemplateVersion: number;
  digest: string;
}): PrebuildTemplateVersion => {
  const files = FILES[`${recorded.prebuildTemplateId}/${recorded.prebuildTemplateVersion}`];
  if (files === undefined)
    throw new Error(
      `versions.json records ${recorded.prebuildTemplateId} version ${recorded.prebuildTemplateVersion} and prebuild-templates.ts imports no files for it; import them`,
    );
  return { ...recorded, ...PrebuildTemplateManifestSchema.parse(files.manifest), devcontainer: files.devcontainer };
};

export const SHIPPED_TEMPLATES: PrebuildTemplateVersion[] =
  RecordedVersionsSchema.parse(recordedVersions).map(shippedVersion);

export const lookUpTemplate = (prebuildTemplateId: string, prebuildTemplateVersion: number): VersionLookup =>
  findVersion(SHIPPED_TEMPLATES, prebuildTemplateId, prebuildTemplateVersion);

export const templateNotFound = (detail: string): Response =>
  problem(404, {
    code: "PrebuildTemplateNotFound",
    title: "No such template",
    detail,
    fix: "List the templates and pick one of their ids and versions",
  });

const COLLECTION = "/v1/prebuild-templates";
const PULL_REQUEST = "/v1/prebuild-templates/pull-request";
const VERSION = /^\/v1\/prebuild-templates\/([^/]+)\/versions\/([^/]+)$/;

const gitHubRefused = (detail: string): Response =>
  problem(409, {
    code: "GitHubRefused",
    title: "GitHub refused the pull request",
    detail,
    fix: "Fix what GitHub's answer names, such as a branch rule that blocks the Tumpel app or the app's access to the repository, then try again; a 5xx answer is an outage on GitHub's side, which https://www.githubstatus.com reports",
  });

type Token = { ok: true; target: GitHubRepository; token: string } | { ok: false; response: Response };

const installationToken = async (
  env: Env,
  caller: Caller,
  url: URL,
  repository: string,
  permissions: Permissions,
): Promise<Token> => {
  const target = githubRepository(repository);
  if (target === null) return { ok: false, response: problem(422, notARepository(repository)) };
  const app = await appKey(env.DB, keyStoreOf(env));
  if (app === null) return { ok: false, response: appMissing(url.origin) };
  const installation = await installationOn(env.DB, caller.tenantId, target.owner);
  if (installation === null || installation.status !== "Active") {
    return {
      ok: false,
      response: problem(409, {
        code: "GitHubNotConnected",
        title: "GitHub not connected",
        detail: `your tenant has no active installation of the GitHub App on ${target.owner}, and the App opens the template pull request on ${target.owner}/${target.name}`,
        fix: `Connect GitHub for ${target.owner}, or unsuspend the App there, then try again`,
      }),
    };
  }
  const token = await mintInstallationWideToken(
    (input, init) => fetch(input, init),
    env.GITHUB_API_ORIGIN,
    app,
    installation.installationId,
    Date.now(),
    { kind: "Exact", permissions },
  );
  if (!token.ok)
    return { ok: false, response: gitHubRefused(`${token.detail}, for the installation on ${target.owner}`) };
  return { ok: true, target, token: token.value };
};

const handleOpen = async (request: Request, url: URL, env: Env, caller: Caller): Promise<Response> => {
  const body = await parseBody(request, PrebuildTemplatePullRequestOpenSchema, "prebuildTemplates.openPullRequest");
  if (!body.ok) return body.response;
  const found = lookUpTemplate(body.value.prebuildTemplateId, body.value.prebuildTemplateVersion);
  if (found.kind === "NotFound") return templateNotFound(found.detail);
  const token = await installationToken(env, caller, url, body.value.repository, {
    contents: "write",
    pull_requests: "write",
  });
  if (!token.ok) return token.response;
  const opened = await openTemplatePullRequest(
    (input, init) => fetch(input, init),
    env.GITHUB_API_ORIGIN,
    token.token,
    token.target,
    { template: found.version, replace: body.value.replace },
  );
  if (opened.kind === "Refused") return gitHubRefused(opened.detail);
  if (opened.kind === "Exists") {
    return problem(409, {
      code: "DevcontainerExists",
      title: "Repository has a devcontainer.json",
      detail: `${token.target.owner}/${token.target.name} already holds ${opened.path} on its default branch`,
      fix: `Edit ${opened.path} in a session, or ask again with replace to swap it for the template`,
    });
  }
  return json(opened.pullRequest);
};

const handleRead = async (url: URL, env: Env, caller: Caller): Promise<Response> => {
  const query = PrebuildTemplatePullRequestQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Invalid query",
      detail: `prebuildTemplates.getPullRequest refused the query: ${issues(query.error)}`,
      fix: "Name the repository, such as ?repository=https://github.com/acme/app",
    });
  }
  const token = await installationToken(env, caller, url, query.data.repository, { pull_requests: "read" });
  if (!token.ok) return token.response;
  const read = await readTemplatePullRequest(
    (input, init) => fetch(input, init),
    env.GITHUB_API_ORIGIN,
    token.token,
    token.target,
  );
  if (read.kind === "Refused") return gitHubRefused(read.detail);
  if (read.kind === "None") {
    return problem(404, {
      code: "NotFound",
      title: "No template pull request",
      detail: `${token.target.owner}/${token.target.name} has no pull request from the branch tumpel/prebuild-template`,
      fix: "Open a pull request with a template first",
    });
  }
  return json(read.pullRequest);
};

export const handlePrebuildTemplates = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const { pathname } = url;
  const version = VERSION.exec(pathname);
  const list = pathname === COLLECTION && request.method === "GET";
  const pullRequest = pathname === PULL_REQUEST && (request.method === "GET" || request.method === "POST");
  if (!list && !pullRequest && !(version !== null && request.method === "GET")) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (list) return json(catalog(SHIPPED_TEMPLATES));
  if (pullRequest && request.method === "POST") return handleOpen(request, url, env, caller);
  if (pullRequest) return handleRead(url, env, caller);
  const prebuildTemplateId = decodeURIComponent(version?.[1] ?? "");
  const found = lookUpTemplate(prebuildTemplateId, Number(decodeURIComponent(version?.[2] ?? "")));
  if (found.kind === "NotFound") return templateNotFound(found.detail);
  return json(found.version);
};
