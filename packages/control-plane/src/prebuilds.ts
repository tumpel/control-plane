import { PrebuildListQuerySchema, PrebuildPathSchema, PrebuildStartSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { CIRCLECI_PARAMETER_LIMIT, circleCIParameters, overLongParameter } from "./circleci.ts";
import { type GitHubRepository, githubRepository, repositoryUrl } from "./github.ts";
import { HARNESS_CATALOG, pinnedEntry } from "./harness-catalog";
import type { Outcome, Refused } from "./hosts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { inputDigest, readInputs } from "./prebuild-inputs.ts";
import { signerOf } from "./presign";
import { currentRelease, imagesFor, type ReleaseImage, rootfsKey } from "./releases";
import { settingsOf } from "./settings";
import type { BuildProvider, Prebuild, PrebuildFailure, PrebuildKey } from "./tenant-prebuilds";

export type PrebuildStart = z.infer<typeof PrebuildStartSchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const PREBUILDS_PATH = "/v1/prebuilds";
const LATEST_PATH = "/v1/prebuilds/latest";
const PREBUILD_PATH = /^\/v1\/prebuilds\/([^/]+)(\/failure)?$/;
const PREBUILD_ARCHITECTURE = "Amd64";

const CONNECT_COMMANDS: Record<BuildProvider, string> = {
  GitHubActions: "tumpel github-actions start",
  CircleCI: "tumpel circleci authorize",
  Namespace: "tumpel namespace start",
};

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
    fix: "List a repository's prebuilds with tumpel prebuild list --repository <url>",
  });

const notGitHub = (repository: string): Refused =>
  refuse(422, {
    code: "InvalidRequest",
    title: "Not a GitHub repository",
    detail: `${repository} is not a GitHub repository URL; prebuilds read their inputs from GitHub`,
    fix: "Pass a repository like https://github.com/acme/app.git",
  });

export const noBuildProvider = (provider: BuildProvider, repository: string): Refused =>
  refuse(409, {
    code: "NoBuildProvider",
    title: "Build provider not connected",
    detail: `your tenant has not connected ${provider}, so no prebuild of ${repository} can run on it`,
    fix: `Connect your own ${provider} account with ${CONNECT_COMMANDS[provider]}, or name a connected provider, then start the prebuild again`,
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
    fix: "Bind it once with tumpel circleci project add --repository <url> --project-slug <slug> --pipeline-definition-id <uuid>, then start the prebuild again",
  });

const dispatchRefused = (detail: string): Refused =>
  refuse(409, {
    code: "DispatchRefused",
    title: "GitHub refused the dispatch",
    detail,
    fix: "Start the prebuild again; if GitHub keeps refusing, check https://www.githubstatus.com",
  });

const listed = (names: string[]): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const appPermissionMissing = (target: GitHubRepository, permissions: string[]): Refused =>
  refuse(409, {
    code: "GitHubAppPermissionMissing",
    title: "GitHub App needs more access",
    detail: `the Tumpel app on GitHub needs Read and write access to ${listed(permissions)} to add its prebuild workflow to ${target.owner}/${target.name} and start it, and ${target.owner} has not granted that yet`,
    fix: `On GitHub, open the settings of ${target.owner}, go to GitHub Apps, choose Configure next to the Tumpel app, then Review request and Accept new permissions; then start the prebuild again`,
  });

const callerWorkflowRefused = (detail: string): Refused =>
  refuse(409, {
    code: "CallerWorkflowRefused",
    title: "Prebuild workflow not added",
    detail: `Tumpel could not add its prebuild workflow to the repository: ${detail}`,
    fix: "Start the prebuild again; if the default branch is protected, allow the Tumpel app to push to it first",
  });

const pipelineRefused = (detail: string): Refused =>
  refuse(409, {
    code: "DispatchRefused",
    title: "CircleCI refused the pipeline",
    detail,
    fix: "Commit the config that imports the orb tumpel/prebuild and declares the five tumpel_* parameters at the path the pipeline definition names, on the default branch, then start the prebuild again",
  });

const rootfsUrlOf = (env: Env, image: ReleaseImage, now: number): Promise<string> => {
  const settings = settingsOf(env);
  return signerOf(env, env.RELEASES_BUCKET_NAME, env.RELEASES_ACCESS_KEY_ID, env.RELEASES_SECRET_ACCESS_KEY).presign(
    "GET",
    rootfsKey(image),
    settings.prebuildDispatchBudgetSeconds + settings.prebuildBuildBudgetSeconds,
    new Date(now),
  );
};

export interface Dispatch {
  prebuildId: string;
  tenantId: string;
  personaId: string;
  key: PrebuildKey;
  target: GitHubRepository;
  defaultBranch: string;
  headSha: string;
  image: ReleaseImage;
  apiOrigin: string;
}

const dispatchGitHubActions = async (env: Env, dispatch: Dispatch, now: number): Promise<Outcome<Prebuild>> => {
  const { prebuildId, tenantId, target, key, image } = dispatch;
  const tenant = env.TENANT.getByName(tenantId);
  const connection = await tenant.gitHubActionsConnection(tenantId);
  if (connection === null) return noBuildProvider("GitHubActions", key.repository);
  const rootfsUrl = await rootfsUrlOf(env, image, now);
  const dispatched = await tenant.dispatchPrebuild(
    tenantId,
    connection.callerWorkflow,
    {
      prebuildId,
      personaId: dispatch.personaId,
      key,
      target,
      defaultBranch: dispatch.defaultBranch,
      headSha: dispatch.headSha,
      rootfsUrl,
      apiOrigin: dispatch.apiOrigin,
    },
    now,
  );
  if (dispatched.kind === "NoInstallation") {
    return refuse(409, {
      code: "GitHubNotConnected",
      title: "GitHub not connected",
      detail: `your tenant has not installed the stage's GitHub App, and a GitHub Actions prebuild of ${key.repository} dispatches its caller workflow with the App`,
      fix: "Install it with tumpel github start on the repository's owner, then start the prebuild again",
    });
  }
  if (dispatched.kind === "PermissionMissing") return appPermissionMissing(target, dispatched.permissions);
  if (dispatched.kind === "CallerRefused") return callerWorkflowRefused(dispatched.detail);
  if (dispatched.kind === "Refused") return dispatchRefused(dispatched.detail);
  return ok(dispatched.prebuild);
};

const dispatchCircleCI = async (env: Env, dispatch: Dispatch, now: number): Promise<Outcome<Prebuild>> => {
  const { prebuildId, tenantId, key, image } = dispatch;
  const tenant = env.TENANT.getByName(tenantId);
  const project = await tenant.circleCIProjectOf(tenantId, key.repository);
  if (project === null) return circleCIProjectMissing(key.repository);
  const rootfsUrl = await rootfsUrlOf(env, image, now);
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
      target: dispatch.target,
      defaultBranch: dispatch.defaultBranch,
      headSha: dispatch.headSha,
      rootfsUrl,
      apiOrigin: dispatch.apiOrigin,
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
  const release = await currentRelease(env.RELEASES, now);
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
      fix: `Pin a version tumpel release current lists for ${PREBUILD_ARCHITECTURE} with tumpel harness pin, then start the prebuild again`,
    });
  }
  return ok(image);
};

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
  const persona = await tenant.getPersona(caller.tenantId, start.personaId);
  if (persona === null) {
    return refuse(404, {
      code: "NotFound",
      title: "No such persona",
      detail: `your tenant has no persona ${start.personaId}`,
      fix: "List your personas with tumpel persona list",
    });
  }
  if (!(await tenant.buildProviderConnected(start.provider))) return noBuildProvider(start.provider, repository);
  const entry = pinnedEntry(await tenant.listPins(), persona.harness);
  if (entry === undefined) {
    return refuse(422, {
      code: "HarnessNotInCatalog",
      title: "Harness not in the catalog",
      detail: `persona ${persona.name} runs ${persona.harness}, of which the catalog has no version your tenant can run; it holds ${HARNESS_CATALOG.map((listed) => `${listed.harness} ${listed.harnessVersion}`).join(", ")}`,
      fix: "Pin a listed version of that harness, or point the persona at a harness the catalog lists, with tumpel config apply",
    });
  }
  const image = await guestImage(env, entry.harness, entry.harnessVersion, now);
  if (!image.ok) return image;
  const token = await tenant.repositoryReadToken(caller.tenantId, start.personaId, target, now);
  if (token.kind === "Refused") return repositoryUnreadable(token.detail);
  const inputs = await readInputs((url, init) => fetch(url, init), env.GITHUB_API_ORIGIN, target, token.token);
  if (inputs.kind === "Unreadable") return repositoryUnreadable(inputs.detail);
  const key = {
    repository,
    inputDigest: await inputDigest(inputs.files),
    guestImageDigest: image.value.imageDigest,
    configSource: inputs.configSource,
  };
  if (!start.rebuild) {
    const held = await tenant.heldPrebuild(caller.tenantId, key);
    if (held !== null) return ok(held);
  }
  if (start.provider === "Namespace") return buildProviderUnavailable(start.provider, repository);
  return (start.provider === "CircleCI" ? dispatchCircleCI : dispatchGitHubActions)(
    env,
    {
      prebuildId: crypto.randomUUID(),
      tenantId: caller.tenantId,
      personaId: start.personaId,
      key,
      target,
      defaultBranch: inputs.defaultBranch,
      headSha: inputs.headSha,
      image: image.value,
      apiOrigin,
    },
    now,
  );
};

const repositoryUnreadable = (detail: string): Refused =>
  refuse(409, {
    code: "RepositoryUnreadable",
    title: "Repository unreadable",
    detail,
    fix: "Give the GitHub App installation or the persona's GITHUB_TOKEN read access to the repository, then start the prebuild again",
  });

export const listPrebuilds = async (env: Env, caller: Caller, repository: string): Promise<Outcome<Prebuild[]>> => {
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
    fix: `Read the prebuild with tumpel prebuild get ${prebuildId}`,
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
  const one = latest ? null : PREBUILD_PATH.exec(pathname);
  const collection = pathname === PREBUILDS_PATH && (request.method === "POST" || request.method === "GET");
  if (!latest && !collection && !(one !== null && request.method === "GET")) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (latest) return json(await listLatestPrebuilds(env, caller));
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
