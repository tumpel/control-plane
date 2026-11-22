import {
  PrebuildListQuerySchema,
  PrebuildPathSchema,
  type PrebuildPreviewRequestSchema,
  type PrebuildPreviewSchema,
  PrebuildStartSchema,
  PrebuildPreviewRequestSchema as PreviewRequestSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { type LifecycleCommand, readDevcontainer } from "./devcontainer.ts";
import { type GitHubRepository, githubRepository, notARepository, repositoryUrl } from "./github.ts";
import { GUEST_TOOLCHAINS } from "./guest-toolchains.ts";
import { HARNESS_CATALOG, type HarnessCatalogEntry, pinnedEntry } from "./harness-catalog";
import { listHosts, type Outcome, type Refused } from "./hosts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import {
  DEVCONTAINER_CONFIGS,
  gitBlobSha,
  inputDigest,
  readBlobText,
  readDefaultBranch,
  readInputs,
} from "./prebuild-inputs.ts";
import { SHIPPED_TEMPLATES } from "./prebuild-templates.ts";
import { type ReleaseBaseImage, readRelease, releaseUnreadable, rootfsKey } from "./releases";
import { placed } from "./sessions";
import { TEMPLATE_PATH } from "./template-pull-request.ts";
import { tenantApi } from "./tenant-api.ts";
import type { Prebuild, PrebuildFailure } from "./tenant-prebuilds";
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

const prebuildNotFound = (prebuildId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "No such prebuild",
    detail: `your tenant has no prebuild ${prebuildId}`,
    fix: "List the repository's prebuilds and use one of their ids",
  });

const notGitHub = (repository: string): Refused => refuse(422, notARepository(repository));

const baseImage = async (env: Env, now: number): Promise<Outcome<ReleaseBaseImage>> => {
  const release = await readRelease(env.RELEASES, now);
  if (release.kind === "Unreadable") return refuse(422, releaseUnreadable(release.detail, "start the prebuild again"));
  if (release.kind === "Unpublished") {
    return refuse(409, {
      code: "NoRelease",
      title: "No release published",
      detail: "the release bucket of this stage holds no current.json, so no base image exists to build a prebuild on",
      fix: "Ask the operator to publish a release with the release workflow, then start the prebuild again",
    });
  }
  const base = release.manifest.bases.find((each) => each.architecture === PREBUILD_ARCHITECTURE);
  if (base === undefined) {
    return refuse(422, {
      code: "ImageNotReleased",
      title: "No base image in the current release",
      detail: `release ${release.manifest.releaseVersion} carries no base image for ${PREBUILD_ARCHITECTURE}, the architecture prebuilds build on`,
      fix: `Ask the operator to publish a release with a ${PREBUILD_ARCHITECTURE} base image, then start the prebuild again`,
    });
  }
  return ok(base);
};

interface PersonaImage {
  harness: HarnessCatalogEntry["harness"];
  harnessVersion: string;
  image: ReleaseBaseImage;
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
  const image = await baseImage(env, now);
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
  const tenant = tenantApi(env.TENANT, caller.tenantId);
  const harness = await personaImage(env, caller, start.personaId, now);
  if (!harness.ok) return harness;
  const entry = harness.value;
  const { read: token } = await tenant.call("repositoryReadToken", {
    tenantId: caller.tenantId,
    personaId: start.personaId,
    repository: target,
    now,
    permissions: { contents: "read" },
  });
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
    const { prebuild: held } = await tenant.call("heldPrebuild", { tenantId: caller.tenantId, key });
    if (held !== null) return ok(held);
  }
  if (inputs.configSource === "Default") return devcontainerMissing(target);
  const prebuildId = crypto.randomUUID();
  const { started } = await tenant.call("startHostPrebuild", {
    tenantId: caller.tenantId,
    commit: {
      prebuildId,
      personaId: start.personaId,
      key,
      configSource: inputs.configSource,
      defaultBranch: described.branch,
      headSha: inputs.headSha,
      rootfsKey: rootfsKey(entry.image),
    },
    provider: start.provider,
    input: {
      principalId: caller.principalId,
      startedBy: { kind: "Person", principalId: caller.principalId },
      hosts: await listHosts(env, caller.tenantId),
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
  });
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
  const { read: token } = await tenantApi(env.TENANT, caller.tenantId).call("repositoryReadToken", {
    tenantId: caller.tenantId,
    personaId: request.personaId,
    repository: target,
    now,
    permissions: { contents: "read" },
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
  const list = async (url: string | null) =>
    (await tenantApi(env.TENANT, caller.tenantId).call("listPrebuilds", { tenantId: caller.tenantId, repository: url }))
      .prebuilds;
  if (repository === undefined) return ok(await list(null));
  const target = githubRepository(repository);
  if (target === null) return notGitHub(repository);
  return ok(await list(repositoryUrl(target)));
};

export const listLatestPrebuilds = async (env: Env, caller: Caller): Promise<Prebuild[]> =>
  (await tenantApi(env.TENANT, caller.tenantId).call("listLatestPrebuilds", { tenantId: caller.tenantId })).prebuilds;

export const getPrebuild = async (env: Env, caller: Caller, prebuildId: string): Promise<Outcome<Prebuild>> => {
  const { prebuild } = await tenantApi(env.TENANT, caller.tenantId).call("getPrebuild", {
    tenantId: caller.tenantId,
    prebuildId,
  });
  return prebuild === null ? prebuildNotFound(prebuildId) : ok(prebuild);
};

export const getPrebuildFailure = async (
  env: Env,
  caller: Caller,
  prebuildId: string,
): Promise<Outcome<PrebuildFailure>> => {
  const tenant = tenantApi(env.TENANT, caller.tenantId);
  const { failure } = await tenant.call("getPrebuildFailure", { tenantId: caller.tenantId, prebuildId });
  if (failure !== null) return ok(failure);
  const { prebuild } = await tenant.call("getPrebuild", { tenantId: caller.tenantId, prebuildId });
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
