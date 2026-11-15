import { PrebuildListQuerySchema, PrebuildPathSchema, PrebuildStartSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { githubRepository } from "./github.ts";
import type { Outcome, Refused } from "./hosts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import type { Prebuild, PrebuildFailure } from "./tenant-prebuilds";

export type PrebuildStart = z.infer<typeof PrebuildStartSchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const PREBUILDS_PATH = "/v1/prebuilds";
const PREBUILD_PATH = /^\/v1\/prebuilds\/([^/]+)(\/failure)?$/;

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

export const noBuildProvider = (repository: string): Refused =>
  refuse(409, {
    code: "NoBuildProvider",
    title: "No build provider",
    detail: `your tenant has no build provider connected, so no prebuild of ${repository} can run`,
    fix: "Connect a build provider of your own, then start the prebuild again",
  });

export const startPrebuild = async (env: Env, caller: Caller, start: PrebuildStart): Promise<Outcome<Prebuild>> => {
  if (githubRepository(start.repository) === null) {
    return refuse(422, {
      code: "InvalidRequest",
      title: "Not a GitHub repository",
      detail: `${start.repository} is not a GitHub repository URL; prebuilds read their inputs from GitHub`,
      fix: "Pass a repository like https://github.com/acme/app.git",
    });
  }
  if (!(await tenantOf(env, caller).hasPersona(start.personaId))) {
    return refuse(404, {
      code: "NotFound",
      title: "No such persona",
      detail: `your tenant has no persona ${start.personaId}`,
      fix: "List your personas with tumpel persona list",
    });
  }
  return noBuildProvider(start.repository);
};

export const listPrebuilds = async (env: Env, caller: Caller, repository: string): Promise<Outcome<Prebuild[]>> =>
  ok(await tenantOf(env, caller).listPrebuilds(caller.tenantId, repository));

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
  const one = PREBUILD_PATH.exec(pathname);
  const collection = pathname === PREBUILDS_PATH && (request.method === "POST" || request.method === "GET");
  if (!collection && !(one !== null && request.method === "GET")) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (collection && request.method === "POST") {
    const body = await parseBody(request, PrebuildStartSchema, "prebuilds.start");
    if (!body.ok) return body.response;
    return answer(await startPrebuild(env, caller, body.value));
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
