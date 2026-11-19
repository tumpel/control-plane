import {
  PrebuildListQuerySchema,
  PrebuildPathSchema,
  type PrebuildPreviewRequestSchema,
  type PrebuildPreviewSchema,
  PrebuildStartSchema,
  PrebuildPreviewRequestSchema as PreviewRequestSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { CIRCLECI_PARAMETER_LIMIT, circleCIParameters, overLongParameter } from "./circleci.ts";
import { type LifecycleCommand, readDevcontainer } from "./devcontainer.ts";
import { type GitHubRepository, githubRepository, notARepository, repositoryUrl } from "./github.ts";
import { GUEST_TOOLCHAINS } from "./guest-toolchains.ts";
import { HARNESS_CATALOG, type HarnessCatalogEntry, pinnedEntry } from "./harness-catalog";
import { listHosts, type Outcome, type Refused } from "./hosts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import type { ConfigSource } from "./prebuild-inputs.ts";
import {
  DEVCONTAINER_CONFIGS,
  gitBlobSha,
  inputDigest,
  readBlobText,
  readDefaultBranch,
  readInputs,
} from "./prebuild-inputs.ts";
import { SHIPPED_TEMPLATES } from "./prebuild-templates.ts";
import { signerOf } from "./presign";
import { imagesFor, type ReleaseImage, readRelease, releaseUnreadable, rootfsKey } from "./releases";
import { placed } from "./sessions";
import { settingsOf } from "./settings";
import { TEMPLATE_PATH } from "./template-pull-request.ts";
import { tenantApi } from "./tenant-api.ts";
import type { BuildProvider, Prebuild, PrebuildFailure, PrebuildKey } from "./tenant-prebuilds";
import { PREBUILD_ARCHITECTURE } from "./tenant-sessions";
import { toolchainFindings } from "./toolchain-files.ts";

export type PrebuildStart = z.infer<typeof PrebuildStartSchema>;
export type PrebuildPreviewRequest = z.infer<typeof PrebuildPreviewRequestSchema>;
export type PrebuildPreview = z.infer<typeof PrebuildPreviewSchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const PREBUILDS_PATH = "/v1/prebuilds";
const LATEST_PATH = "/v1/prebuilds/latest";
const PREVIEW_PATH = "/v1/prebuilds/preview";
const PREBUILD_PATH = /^\/v1\/prebuilds\/([^/]+)(\/failure)?$/;
const PREBUILD_MODEL = "prebuild";

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

const refuse = (status: Refused["status"], refused: Refused["problem"]): Refused => ({
  ok: false,
  status,
  problem: refused,
});

const tenantOf = (env: Env, caller: Caller) => env.TENANT.getByName(caller.tenantId);

const prebuildNotFound = (prebuildId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "No such prebuild",
    detail: `your tenant has no prebuild ${prebuildId}`,
    fix: "List the repository's prebuilds and use one of their ids",
  });

const notGitHub = (repository: string): Refused => refuse(422, notARepository(repository));

export const noBuildProvider = (provider: BuildProvider, repository: string): Refused =>
  refuse(409, {
    code: "NoBuildProvider",
    title: "Build provider not connected",
    detail: `your tenant has not connected ${provider}, so no prebuild of ${repository} can run on it`,
    fix: `Connect your own ${provider} account, or name a connected provider, then start the prebuild again`,
  });

const buildProviderUnavailable = (provider: BuildProvider, repository: string): Refused =>
  refuse(409, {
    code: "BuildProviderUnavailable",
    title: "Build provider unavailable",
    detail: `your tenant connected ${provider}, and this control plane cannot dispatch a prebuild to ${provider} yet, so no prebuild of ${repository} was started`,
    fix: "Start the prebuild again once the operator deploys a control plane that dispatches to this provider",
  });

const circleCIProjectMissing = (repository: string): Refused =>
  refuse(409, {
    code: "CircleCIProjectMissing",
    title: "Repository not bound to CircleCI",
    detail: `your tenant has bound no CircleCI project to ${repository}, so CircleCI has no pipeline to run its prebuild`,
    fix: "Bind the repository to its CircleCI project once, then start the prebuild again",
  });

const actionsDisabled = (target: GitHubRepository, detail: string): Refused =>
  refuse(409, {
    code: "DispatchRefused",
    title: "GitHub Actions disabled",
    detail,
    fix: `On GitHub, open the settings of ${target.owner}/${target.name}, go to Actions, General, and allow actions and reusable workflows, at least tumpel/workflows; if the Actions tab lists the tumpel prebuild workflow as disabled, enable it there; then start the prebuild`,
  });

const tokenRefused = (target: GitHubRepository, detail: string): Refused =>
  refuse(409, {
    code: "DispatchRefused",
    title: "GitHub refused the installation token",
    detail,
    fix: `On GitHub, open the settings of ${target.owner}, go to GitHub Apps, choose Configure next to the Tumpel app, and check that it is not suspended and has access to ${target.name}; if the App is gone, connect GitHub for ${target.owner} again`,
  });

const gitHubRefused = (detail: string): Refused =>
  refuse(409, {
    code: "DispatchRefused",
    title: "GitHub refused the dispatch",
    detail,
    fix: "Fix what GitHub's answer in the detail names; a 5xx answer is an outage on GitHub's side, which https://www.githubstatus.com reports",
  });

const listed = (names: string[]): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const appPermissionMissing = (target: GitHubRepository, permissions: string[], appSlug: string): Refused =>
  refuse(409, {
    code: "GitHubAppPermissionMissing",
    title: "GitHub App needs more access",
    detail: `the GitHub App ${appSlug} asks for Read and write access to ${listed(permissions)}, which it needs to add its prebuild workflow to ${target.owner}/${target.name} and start it, and ${target.owner} has not accepted that request yet`,
    fix: `On GitHub, open the settings of ${target.owner}, go to GitHub Apps, choose Configure next to ${appSlug}, then Review request and Accept new permissions; then start the prebuild again`,
  });

const appLacksPermission = (
  target: GitHubRepository,
  permissions: string[],
  appSlug: string,
  appOwner: string,
): Refused =>
  refuse(409, {
    code: "GitHubAppPermissionMissing",
    title: "GitHub App needs more access",
    detail: `the GitHub App ${appSlug} itself holds less than Read and write access to ${listed(permissions)}, which it needs to add its prebuild workflow to ${target.owner}/${target.name} and start it, so no installation can grant it`,
    fix: `${appOwner}, who owns the App, opens its settings on GitHub under Developer settings, GitHub Apps, ${appSlug}, Permissions and events, sets ${listed(permissions)} to Read and write under Repository permissions and saves; then ${target.owner} opens Settings, GitHub Apps, Configure next to ${appSlug}, Review request and accepts the new permissions; then start the prebuild again`,
  });

const callerWorkflowRefused = (detail: string): Refused =>
  refuse(409, {
    code: "CallerWorkflowRefused",
    title: "Prebuild workflow not added",
    detail: `Tumpel could not add its prebuild workflow to the repository: ${detail}`,
    fix: "When the default branch is protected, let the Tumpel app push to it in the branch protection rule or ruleset, or commit the caller workflow the GitHub Actions connection shows at its path yourself; then start the prebuild",
  });

const pipelineRefused = (detail: string): Refused =>
  refuse(409, {
    code: "DispatchRefused",
    title: "CircleCI refused the pipeline",
    detail,
    fix: "Commit the config that imports the orb tumpel/prebuild and declares the five tumpel_* parameters at the path the pipeline definition names, on the default branch, then start the prebuild again",
  });

export const presignRootfs = (env: Env, key: string, now: number): Promise<string> => {
  const settings = settingsOf(env);
  return signerOf(env, env.RELEASES_BUCKET_NAME, env.RELEASES_ACCESS_KEY_ID, env.RELEASES_SECRET_ACCESS_KEY).presign(
    "GET",
    key,
    settings.prebuildDispatchBudgetSeconds + settings.prebuildBuildBudgetSeconds,
    new Date(now),
  );
};

export interface Dispatch {
  prebuildId: string;
  tenantId: string;
  personaId: string;
  key: PrebuildKey;
  configSource: ConfigSource;
  target: GitHubRepository;
  defaultBranch: string;
  headSha: string;
  image: ReleaseImage;
  apiOrigin: string;
}

interface GitHubActionsRequest {
  tenantId: string;
  personaId: string;
  target: GitHubRepository;
  repository: string;
  image: ReleaseImage;
  apiOrigin: string;
  rebuild: boolean;
}

const startGitHubActions = async (env: Env, request: GitHubActionsRequest, now: number): Promise<Outcome<Prebuild>> => {
  const { tenantId, target, repository, image } = request;
  const tenant = env.TENANT.getByName(tenantId);
  const connection = await tenant.gitHubActionsConnection(tenantId);
  if (connection === null) return noBuildProvider("GitHubActions", repository);
  const started = await tenant.startGitHubActionsPrebuild(
    tenantId,
    {
      prebuildId: crypto.randomUUID(),
      personaId: request.personaId,
      target,
      repository,
      guestImageDigest: image.imageDigest,
      rootfsKey: rootfsKey(image),
      callerWorkflow: connection.callerWorkflow,
      apiOrigin: request.apiOrigin,
      rebuild: request.rebuild,
    },
    now,
  );
  switch (started.kind) {
    case "Started":
      return ok(started.prebuild);
    case "NoInstallation":
      return refuse(409, {
        code: "GitHubNotConnected",
        title: "GitHub not connected",
        detail: `your tenant has not installed the stage's GitHub App on ${target.owner}, and a GitHub Actions prebuild of ${repository} adds and starts its caller workflow with the App`,
        fix: "Connect GitHub for the repository's owner, then start the prebuild",
      });
    case "TokenRefused":
      return tokenRefused(target, started.detail);
    case "Unreadable":
      return installationUnreadable(target, started.detail);
    case "PermissionMissing":
      return appPermissionMissing(target, started.permissions, started.appSlug);
    case "AppPermissionMissing":
      return appLacksPermission(target, started.permissions, started.appSlug, started.appOwner);
    case "CallerRefused":
      return callerWorkflowRefused(started.detail);
    case "ActionsDisabled":
      return actionsDisabled(target, started.detail);
    case "Refused":
      return gitHubRefused(started.detail);
  }
};

const dispatchCircleCI = async (env: Env, dispatch: Dispatch, now: number): Promise<Outcome<Prebuild>> => {
  const { prebuildId, tenantId, key, image } = dispatch;
  const tenant = env.TENANT.getByName(tenantId);
  const project = await tenant.circleCIProjectOf(tenantId, key.repository);
  if (project === null) return circleCIProjectMissing(key.repository);
  const rootfsUrl = await presignRootfs(env, rootfsKey(image), now);
  const parameters = circleCIParameters({
    prebuildId,
    tenantId,
    apiOrigin: dispatch.apiOrigin,
    rootfsUrl,
    imageDigest: image.imageDigest,
  });
  const overLong = overLongParameter(parameters);
  if (overLong !== null) {
    return refuse(409, {
      code: "DispatchRefused",
      title: "Pipeline parameter too long",
      detail: `pipeline parameter ${overLong.name} is ${overLong.length} characters, and CircleCI takes at most ${CIRCLECI_PARAMETER_LIMIT}; no pipeline was triggered`,
      fix: "Ask the operator to serve the releases bucket under a shorter presigned URL, then start the prebuild again",
    });
  }
  const dispatched = await tenant.dispatchCircleCIPrebuild(
    tenantId,
    {
      prebuildId,
      personaId: dispatch.personaId,
      key,
      configSource: dispatch.configSource,
      target: dispatch.target,
      defaultBranch: dispatch.defaultBranch,
      headSha: dispatch.headSha,
      rootfsKey: rootfsKey(image),
    },
    project,
    parameters,
    now,
  );
  if (dispatched.kind === "NotConnected") return noBuildProvider("CircleCI", key.repository);
  if (dispatched.kind === "Refused") return pipelineRefused(dispatched.detail);
  return ok(dispatched.prebuild);
};

const guestImage = async (
  env: Env,
  harness: string,
  harnessVersion: string,
  now: number,
): Promise<Outcome<ReleaseImage>> => {
  const release = await readRelease(env.RELEASES, now);
  if (release.kind === "Unreadable") return refuse(422, releaseUnreadable(release.detail, "start the prebuild again"));
  if (release.kind === "Unpublished") {
    return refuse(409, {
      code: "NoRelease",
      title: "No release published",
      detail: "the release bucket of this stage holds no current.json, so no guest image exists to build a prebuild on",
      fix: "Ask the operator to publish a release with the release workflow, then start the prebuild again",
    });
  }
  const image = imagesFor(release, harness, harnessVersion).find((each) => each.architecture === PREBUILD_ARCHITECTURE);
  if (image === undefined) {
    return refuse(422, {
      code: "ImageNotReleased",
      title: "Harness version not in the current release",
      detail: `release ${release.manifest.releaseVersion} carries no ${harness} ${harnessVersion} guest image for ${PREBUILD_ARCHITECTURE}, the architecture prebuilds build on`,
      fix: `Pin a harness version the current release carries for ${PREBUILD_ARCHITECTURE}, then start the prebuild again`,
    });
  }
  return ok(image);
};

interface PersonaImage {
  harness: HarnessCatalogEntry["harness"];
  harnessVersion: string;
  image: ReleaseImage;
}

const personaImage = async (
  env: Env,
  caller: Caller,
  personaId: string,
  now: number,
): Promise<Outcome<PersonaImage>> => {
  const { persona } = await tenantApi(env.TENANT, caller.tenantId).call("getPersona", {
    tenantId: caller.tenantId,
    personaId,
  });
  if (persona === null) {
    return refuse(404, {
      code: "NotFound",
      title: "No such persona",
      detail: `your tenant has no persona ${personaId}`,
      fix: "List your personas and use one of their ids",
    });
  }
  const entry = pinnedEntry((await tenantApi(env.TENANT, caller.tenantId).call("listPins", {})).pins, persona.harness);
  if (entry === undefined) {
    return refuse(422, {
      code: "HarnessNotInCatalog",
      title: "Harness not in the catalog",
      detail: `persona ${persona.name} runs ${persona.harness}, of which the catalog has no version your tenant can run; it holds ${HARNESS_CATALOG.map((listed) => `${listed.harness} ${listed.harnessVersion}`).join(", ")}`,
      fix: "Pin a listed version of that harness, or point the persona at a harness the catalog lists",
    });
  }
  const image = await guestImage(env, entry.harness, entry.harnessVersion, now);
  if (!image.ok) return image;
  return ok({ harness: entry.harness, harnessVersion: entry.harnessVersion, image: image.value });
};

export const devcontainerMissing = (target: GitHubRepository): Refused =>
  refuse(409, {
    code: "DevcontainerMissing",
    title: "No devcontainer.json",
    detail: `${target.owner}/${target.name} holds neither .devcontainer/devcontainer.json nor .devcontainer.json on its default branch, so a prebuild has no commands to run`,
    fix: `Open a pull request with one of the templates ${[...new Set(SHIPPED_TEMPLATES.map((template) => template.prebuildTemplateId))].join(", ")}, or commit a .devcontainer/devcontainer.json, then try again`,
  });

export const startPrebuild = async (
  env: Env,
  caller: Caller,
  start: PrebuildStart,
  apiOrigin: string,
  now: number,
): Promise<Outcome<Prebuild>> => {
  const target = githubRepository(start.repository);
  if (target === null) return notGitHub(start.repository);
  const repository = repositoryUrl(target);
  const tenant = tenantOf(env, caller);
  const harness = await personaImage(env, caller, start.personaId, now);
  if (!harness.ok) return harness;
  const entry = harness.value;
  const token = await tenant.repositoryReadToken(caller.tenantId, start.personaId, target, now, { contents: "read" });
  if (token.kind === "Refused") return repositoryUnreadable(token.detail);
  const fetcher = (url: string, init: RequestInit) => fetch(url, init);
  const described = await readDefaultBranch(fetcher, env.GITHUB_API_ORIGIN, target, token.token);
  if (described.kind === "Unreadable") return repositoryUnreadable(described.detail);
  const inputs = await readInputs(fetcher, env.GITHUB_API_ORIGIN, target, token.token, described.branch);
  if (inputs.kind === "Unreadable") return repositoryUnreadable(inputs.detail);
  const key = {
    repository,
    inputDigest: await inputDigest(inputs.files),
    guestImageDigest: entry.image.imageDigest,
  };
  if (!start.rebuild) {
    const held = await tenant.heldPrebuild(caller.tenantId, key);
    if (held !== null) return ok(held);
  }
  if (inputs.configSource === "Default") return devcontainerMissing(target);
  const prebuildId = crypto.randomUUID();
  const started = await tenant.startHostPrebuild(
    caller.tenantId,
    {
      prebuildId,
      personaId: start.personaId,
      key,
      configSource: inputs.configSource,
      defaultBranch: described.branch,
      headSha: inputs.headSha,
      rootfsKey: rootfsKey(entry.image),
    },
    start.provider,
    {
      principalId: caller.principalId,
      hosts: await listHosts(env.DB, caller.tenantId),
      harness: entry.harness,
      harnessVersion: entry.harnessVersion,
      endpoint: apiOrigin,
      start: {
        personaId: start.personaId,
        repository,
        model: PREBUILD_MODEL,
        prompt: `Run the setup step of ${repository} at ${inputs.headSha} for prebuild ${prebuildId}`,
      },
    },
    apiOrigin,
    now,
  );
  return placed(started);
};

const LIFECYCLE_NAMES: Record<LifecycleCommand, PrebuildPreview["commands"][number]["lifecycle"]> = {
  onCreateCommand: "OnCreateCommand",
  updateContentCommand: "UpdateContentCommand",
  postCreateCommand: "PostCreateCommand",
  postStartCommand: "PostStartCommand",
};

export const previewPrebuild = async (
  env: Env,
  caller: Caller,
  request: PrebuildPreviewRequest,
  now: number,
): Promise<Outcome<PrebuildPreview>> => {
  const target = githubRepository(request.repository);
  if (target === null) return notGitHub(request.repository);
  const harness = await personaImage(env, caller, request.personaId, now);
  if (!harness.ok) return harness;
  const token = await tenantOf(env, caller).repositoryReadToken(caller.tenantId, request.personaId, target, now, {
    contents: "read",
  });
  if (token.kind === "Refused") return repositoryUnreadable(token.detail);
  const fetcher = (url: string, init: RequestInit) => fetch(url, init);
  const api = env.GITHUB_API_ORIGIN;
  const described = await readDefaultBranch(fetcher, api, target, token.token);
  if (described.kind === "Unreadable") return repositoryUnreadable(described.detail);
  const inputs = await readInputs(fetcher, api, target, token.token, described.branch);
  if (inputs.kind === "Unreadable") return repositoryUnreadable(inputs.detail);
  const [repositoryFile] = DEVCONTAINER_CONFIGS.flatMap((path) => inputs.files.filter((file) => file.path === path));
  const config =
    request.source === "Supplied"
      ? { kind: "Text" as const, path: TEMPLATE_PATH, text: request.devcontainer }
      : repositoryFile === undefined
        ? { kind: "Missing" as const }
        : { ...(await readBlobText(fetcher, api, target, token.token, repositoryFile)), path: repositoryFile.path };
  if (config.kind === "Missing") return devcontainerMissing(target);
  if (config.kind === "Unreadable") return repositoryUnreadable(config.detail);
  const files =
    request.source === "Supplied"
      ? [
          ...inputs.files.filter((file) => file.path !== TEMPLATE_PATH),
          { path: TEMPLATE_PATH, blobSha: await gitBlobSha(config.text) },
        ]
      : inputs.files;
  const toolchainTexts = await Promise.all(
    inputs.toolchainFiles.map(async (file) => ({
      path: file.path,
      read: await readBlobText(fetcher, api, target, token.token, file),
    })),
  );
  const unreadableToolchain = toolchainTexts.find(({ read }) => read.kind === "Unreadable");
  if (unreadableToolchain?.read.kind === "Unreadable") return repositoryUnreadable(unreadableToolchain.read.detail);
  const devcontainer = readDevcontainer(config.text, config.path);
  return ok({
    repository: repositoryUrl(target),
    configSource: request.source,
    commands: devcontainer.commands.map((command) => ({
      lifecycle: LIFECYCLE_NAMES[command.lifecycle],
      label: command.label,
      argv: [command.file, ...command.args],
    })),
    containerEnv: devcontainer.containerEnv,
    inputDigest: await inputDigest(files),
    findings: [
      ...devcontainer.findings,
      ...toolchainFindings(
        toolchainTexts.flatMap(({ path, read }) => (read.kind === "Text" ? [{ path, text: read.text }] : [])),
        GUEST_TOOLCHAINS,
      ),
    ],
  });
};

const installationUnreadable = (target: GitHubRepository, detail: string): Refused =>
  refuse(409, {
    code: "RepositoryUnreadable",
    title: "Repository unreadable",
    detail,
    fix: `Give the GitHub App installation on ${target.owner} access to ${target.owner}/${target.name}, then start the prebuild again`,
  });

const repositoryUnreadable = (detail: string): Refused =>
  refuse(409, {
    code: "RepositoryUnreadable",
    title: "Repository unreadable",
    detail,
    fix: "Give the GitHub App installation or the persona's GITHUB_TOKEN read access to the repository, then start the prebuild again",
  });

export const listPrebuilds = async (
  env: Env,
  caller: Caller,
  repository: string | undefined,
): Promise<Outcome<Prebuild[]>> => {
  if (repository === undefined) return ok(await tenantOf(env, caller).listPrebuilds(caller.tenantId, null));
  const target = githubRepository(repository);
  if (target === null) return notGitHub(repository);
  return ok(await tenantOf(env, caller).listPrebuilds(caller.tenantId, repositoryUrl(target)));
};

export const listLatestPrebuilds = async (env: Env, caller: Caller): Promise<Prebuild[]> =>
  tenantOf(env, caller).listLatestPrebuilds(caller.tenantId);

export const getPrebuild = async (env: Env, caller: Caller, prebuildId: string): Promise<Outcome<Prebuild>> => {
  const prebuild = await tenantOf(env, caller).getPrebuild(caller.tenantId, prebuildId);
  return prebuild === null ? prebuildNotFound(prebuildId) : ok(prebuild);
};

export const getPrebuildFailure = async (
  env: Env,
  caller: Caller,
  prebuildId: string,
): Promise<Outcome<PrebuildFailure>> => {
  const tenant = tenantOf(env, caller);
  const failure = await tenant.getPrebuildFailure(caller.tenantId, prebuildId);
  if (failure !== null) return ok(failure);
  const prebuild = await tenant.getPrebuild(caller.tenantId, prebuildId);
  if (prebuild === null) return prebuildNotFound(prebuildId);
  return refuse(404, {
    code: "NotFound",
    title: "Prebuild did not fail",
    detail: `prebuild ${prebuildId} is ${prebuild.status.state}, and only a Failed prebuild has a failure`,
    fix: `Read prebuild ${prebuildId}`,
  });
};

const answer = <T>(outcome: Outcome<T>): Response =>
  outcome.ok ? json(outcome.value) : problem(outcome.status, outcome.problem);

export const handlePrebuilds = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const { pathname } = url;
  const latest = pathname === LATEST_PATH && request.method === "GET";
  const preview = pathname === PREVIEW_PATH && request.method === "POST";
  const one = latest ? null : PREBUILD_PATH.exec(pathname);
  const collection = pathname === PREBUILDS_PATH && (request.method === "POST" || request.method === "GET");
  if (!latest && !preview && !collection && !(one !== null && request.method === "GET")) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (latest) return json(await listLatestPrebuilds(env, caller));
  if (preview) {
    const body = await parseBody(request, PreviewRequestSchema, "prebuilds.preview");
    if (!body.ok) return body.response;
    return answer(await previewPrebuild(env, caller, body.value, Date.now()));
  }
  if (collection && request.method === "POST") {
    const body = await parseBody(request, PrebuildStartSchema, "prebuilds.start");
    if (!body.ok) return body.response;
    return answer(await startPrebuild(env, caller, body.value, url.origin, Date.now()));
  }
  if (collection) {
    const query = PrebuildListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) {
      return problem(400, {
        code: "InvalidRequest",
        title: "Invalid query",
        detail: `prebuilds.list refused the query: ${issues(query.error)}`,
        fix: "Name the repository, such as ?repository=https://github.com/acme/app.git",
      });
    }
    return answer(await listPrebuilds(env, caller, query.data.repository));
  }
  const raw = decodeURIComponent(one?.[1] ?? "");
  const path = PrebuildPathSchema.safeParse({ prebuildId: raw });
  if (!path.success) return answer(prebuildNotFound(raw));
  if (one?.[2] === "/failure") return answer(await getPrebuildFailure(env, caller, path.data.prebuildId));
  return answer(await getPrebuild(env, caller, path.data.prebuildId));
};
