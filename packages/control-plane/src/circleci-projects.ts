import { CircleCIProjectAddSchema, CircleCIProjectPathSchema } from "@tumpel/api/schemas";
import { readPipelineDefinition, readProject } from "./circleci.ts";
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

const addProject = async (env: Env, caller: Caller, add: CircleCIProjectAdd): Promise<Response> => {
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
  const added = await tenant.addCircleCIProject(
    caller.tenantId,
    {
      repository,
      projectSlug: add.projectSlug,
      projectId: project.value.id,
      pipelineDefinitionId: add.pipelineDefinitionId,
    },
    Date.now(),
  );
  if (added.kind === "Bound") {
    return problem(409, {
      code: "Conflict",
      title: "Repository already bound",
      detail: `${repository} is bound to CircleCI project ${added.project.projectSlug} as ${added.project.circleCIProjectId}`,
      fix: `Delete that binding with tumpel circleci project delete ${added.project.circleCIProjectId}, then add it again`,
    });
  }
  return json(added.project);
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
    return addProject(env, caller, body.value);
  }
  const path = CircleCIProjectPathSchema.safeParse({ circleCIProjectId: decodeURIComponent(one?.[1] ?? "") });
  const deleted = path.success && (await tenantOf(env, caller).deleteCircleCIProject(path.data.circleCIProjectId));
  if (!deleted) {
    return problem(404, {
      code: "NotFound",
      title: "No such CircleCI project binding",
      detail: `your tenant has no CircleCI project binding ${one?.[1] ?? ""}`,
      fix: "List the bindings with tumpel circleci project list",
    });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};
