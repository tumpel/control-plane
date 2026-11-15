import { CircleCIProjectAddSchema, CircleCIProjectPathSchema } from "@tumpel/api/schemas";
import { createWebhook, deleteWebhook, readPipelineDefinition, readProject } from "./circleci.ts";
import { type Fetch, githubRepository, repositoryUrl } from "./github.ts";
import { json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { ownerRequired } from "./members";
import type { CircleCIProjectAdd } from "./tenant-prebuilds";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const PROJECTS_PATH = "/v1/circleci-projects";
const PROJECT_PATH = /^\/v1\/circleci-projects\/([^/]+)$/;

const tenantOf = (env: Env, caller: Caller) => env.TENANT.getByName(caller.tenantId);

const notConnected = (repository: string): Response =>
  problem(409, {
    code: "NoBuildProvider",
    title: "Build provider not connected",
    detail: `your tenant has not connected CircleCI, so ${repository} cannot be bound to a CircleCI project`,
    fix: "Connect your CircleCI organization with tumpel circleci start --token-stdin, then add the binding again",
  });

const projectMissing = (detail: string): Response =>
  problem(404, {
    code: "CircleCIProjectMissing",
    title: "No such CircleCI project",
    detail,
    fix: "Pass the slug Project Settings > Overview shows: gh/<owner>/<name> in a GitHub OAuth organization, circleci/<organization id>/<project id> in a GitHub App organization",
  });

const definitionMismatch = (detail: string): Response =>
  problem(422, {
    code: "CircleCIDefinitionMismatch",
    title: "Pipeline definition does not fit",
    detail,
    fix: "Pass the id of a pipeline definition of this project that checks out the repository, from Project Settings > Project Setup, then add the binding again",
  });

export const circleCIRefused = (answer: { status: number; detail: string }, doing: string): Response => {
  if (answer.status === 401 || answer.status === 403) {
    return problem(422, {
      code: "CircleCITokenRefused",
      title: "CircleCI refused the token",
      detail: `${answer.detail}, ${doing}`,
      fix: "Connect CircleCI again with tumpel circleci start --token-stdin with a personal API token of a member who administers the project, then try again",
    });
  }
  return problem(409, {
    code: "CircleCIRefused",
    title: "CircleCI refused the call",
    detail: `${answer.detail}, ${doing}`,
    fix: "Try again once CircleCI answers; check https://status.circleci.com if it keeps failing",
  });
};

const signingSecret = (): string =>
  [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const deleteCircleCIWebhooks = async (
  env: Env,
  token: string,
  webhookIds: readonly string[],
): Promise<Response | null> => {
  for (const webhookId of webhookIds) {
    const answer = await deleteWebhook((url, init) => fetch(url, init), env.CIRCLECI_API_ORIGIN, token, webhookId);
    if (answer.ok || answer.status === 404) continue;
    return circleCIRefused(answer, `deleting webhook ${webhookId}`);
  }
  return null;
};

const addProject = async (env: Env, caller: Caller, add: CircleCIProjectAdd, apiOrigin: string): Promise<Response> => {
  const target = githubRepository(add.repository);
  if (target === null) {
    return problem(422, {
      code: "InvalidRequest",
      title: "Not a GitHub repository",
      detail: `${add.repository} is not a GitHub repository URL; CircleCI prebuilds read their inputs from GitHub`,
      fix: "Pass a repository like https://github.com/acme/app.git",
    });
  }
  const repository = repositoryUrl(target);
  const tenant = tenantOf(env, caller);
  const connection = await tenant.circleCIConnection();
  const token = await tenant.circleCIToken();
  if (connection === null || token === null) return notConnected(repository);
  const fetcher: Fetch = (url, init) => fetch(url, init);
  const project = await readProject(fetcher, env.CIRCLECI_API_ORIGIN, token, add.projectSlug);
  if (!project.ok && (project.status === 401 || project.status === 403)) {
    return problem(422, {
      code: "CircleCITokenRefused",
      title: "CircleCI refused the token",
      detail: `${project.detail}; the connection's token no longer reads CircleCI`,
      fix: "Connect CircleCI again with tumpel circleci start --token-stdin, then add the binding again",
    });
  }
  if (!project.ok) return projectMissing(`${project.detail}, reading project ${add.projectSlug}`);
  if (project.value.organization_id !== connection.organizationId) {
    return projectMissing(
      `project ${add.projectSlug} belongs to CircleCI organization ${project.value.organization_id}, and the connection names ${connection.organizationId}`,
    );
  }
  const definition = await readPipelineDefinition(
    fetcher,
    env.CIRCLECI_API_ORIGIN,
    token,
    project.value.id,
    add.pipelineDefinitionId,
  );
  if (!definition.ok) {
    return definitionMismatch(`${definition.detail}, reading pipeline definition ${add.pipelineDefinitionId}`);
  }
  const checkout = definition.value.checkout_source.repo.full_name;
  if (`https://github.com/${checkout.toLowerCase()}` !== repository) {
    return definitionMismatch(
      `pipeline definition ${add.pipelineDefinitionId} checks out ${checkout}, and the binding names ${repository}`,
    );
  }
  const held = await tenant.circleCIProjectOf(caller.tenantId, repository);
  if (held !== null) return alreadyBound(repository, held.projectSlug, held.circleCIProjectId);
  const secret = signingSecret();
  const hook = await createWebhook(fetcher, env.CIRCLECI_API_ORIGIN, token, {
    projectId: project.value.id,
    url: `${apiOrigin}/v1/circleci-events/${encodeURIComponent(caller.tenantId)}`,
    signingSecret: secret,
  });
  if (!hook.ok)
    return circleCIRefused(hook, `registering the workflow-completed webhook on project ${add.projectSlug}`);
  const added = await tenant.addCircleCIProject(
    caller.tenantId,
    {
      repository,
      projectSlug: add.projectSlug,
      projectId: project.value.id,
      pipelineDefinitionId: add.pipelineDefinitionId,
      webhookId: hook.value.id,
      signingSecret: secret,
    },
    Date.now(),
  );
  return json(added);
};

const alreadyBound = (repository: string, projectSlug: string, circleCIProjectId: string): Response =>
  problem(409, {
    code: "Conflict",
    title: "Repository already bound",
    detail: `${repository} is bound to CircleCI project ${projectSlug} as ${circleCIProjectId}`,
    fix: `Delete that binding with tumpel circleci project delete ${circleCIProjectId}, then add it again`,
  });

const deleteProject = async (env: Env, caller: Caller, raw: string): Promise<Response> => {
  const tenant = tenantOf(env, caller);
  const path = CircleCIProjectPathSchema.safeParse({ circleCIProjectId: raw });
  const webhook = path.success
    ? (await tenant.circleCIWebhooks()).find((each) => each.circleCIProjectId === path.data.circleCIProjectId)
    : undefined;
  const token = await tenant.circleCIToken();
  if (webhook === undefined || token === null) {
    return problem(404, {
      code: "NotFound",
      title: "No such CircleCI project binding",
      detail: `your tenant has no CircleCI project binding ${raw}`,
      fix: "List the bindings with tumpel circleci project list",
    });
  }
  const refused = await deleteCircleCIWebhooks(env, token, [webhook.webhookId]);
  if (refused !== null) return refused;
  await tenant.deleteCircleCIProject(webhook.circleCIProjectId);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};

export const handleCircleCIProjects = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const collection = url.pathname === PROJECTS_PATH && (request.method === "GET" || request.method === "POST");
  const one = request.method === "DELETE" ? PROJECT_PATH.exec(url.pathname) : null;
  if (!collection && one === null) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (collection && request.method === "GET")
    return json(await tenantOf(env, caller).listCircleCIProjects(caller.tenantId));
  const refused = ownerRequired(caller, collection ? "circleCIProjects.add" : "circleCIProjects.delete");
  if (refused) return refused;
  if (collection) {
    const body = await parseBody(request, CircleCIProjectAddSchema, "circleCIProjects.add");
    if (!body.ok) return body.response;
    return addProject(env, caller, body.value, url.origin);
  }
  return deleteProject(env, caller, decodeURIComponent(one?.[1] ?? ""));
};
