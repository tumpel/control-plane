import { CircleCIAuthorizationChooseSchema, CircleCIAuthorizationCompleteSchema } from "@tumpel/schemas";
import { json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { ownerRequired } from "./members";
import type { CircleCIAuthorizationStepped } from "./tenant-circleci-authorizations";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const ROUTES: Record<string, "authorize" | "complete" | "choose"> = {
  "/v1/circleci-connection/authorize": "authorize",
  "/v1/circleci-connection/complete": "complete",
  "/v1/circleci-connection/choose": "choose",
};

const AUTHORIZE_AGAIN = "Connect CircleCI again from the dashboard or with tumpel circleci authorize";

const answer = (
  stepped: CircleCIAuthorizationStepped,
  circleCIAuthorizationId: string,
  operation: string,
): Response => {
  if (stepped.kind === "Stepped") return json(stepped.authorization);
  if (stepped.kind === "NotFound") {
    return problem(404, {
      code: "NotFound",
      title: "No such CircleCI authorization",
      detail: `you started no CircleCI authorization ${circleCIAuthorizationId} in this tenant`,
      fix: AUTHORIZE_AGAIN,
    });
  }
  if (stepped.kind === "NotWaiting") {
    return problem(409, {
      code: "CircleCIAuthorizationNotWaiting",
      title: "CircleCI authorization not waiting",
      detail: stepped.detail,
      fix: AUTHORIZE_AGAIN,
    });
  }
  return problem(422, {
    code: "InvalidRequest",
    title: operation === "complete" ? "Not the redirect address" : "Organization not listed",
    detail: stepped.detail,
    fix:
      operation === "complete"
        ? "Copy the whole address from the browser's address bar after choosing Allow on CircleCI's page, then send it again"
        : "Choose one of the organizations the authorization lists",
  });
};

export const handleCircleCIAuthorizations = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const operation = request.method === "POST" ? ROUTES[url.pathname] : undefined;
  if (operation === undefined) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  const refused = ownerRequired(caller, `circleCIConnections.${operation}`);
  if (refused) return refused;
  const tenant = env.TENANT.getByName(caller.tenantId);
  const now = Date.now();
  if (operation === "authorize") {
    const started = await tenant.startCircleCIAuthorization(caller.tenantId, caller.principalId, now);
    if (started.kind === "Started") return json(started.authorization);
    return problem(409, {
      code: "CircleCIRefused",
      title: "CircleCI refused the client registration",
      detail: `${started.detail}, registering this tenant's CircleCI client`,
      fix: "Try again once CircleCI answers; check https://status.circleci.com if it keeps failing, or paste a personal API token instead",
    });
  }
  if (operation === "complete") {
    const body = await parseBody(request, CircleCIAuthorizationCompleteSchema, "circleCIConnections.complete");
    if (!body.ok) return body.response;
    const { circleCIAuthorizationId, redirectedUrl } = body.value;
    const stepped = await tenant.completeCircleCIAuthorization(
      caller.tenantId,
      caller.principalId,
      circleCIAuthorizationId,
      redirectedUrl,
      now,
    );
    return answer(stepped, circleCIAuthorizationId, operation);
  }
  const body = await parseBody(request, CircleCIAuthorizationChooseSchema, "circleCIConnections.choose");
  if (!body.ok) return body.response;
  const { circleCIAuthorizationId, organizationId } = body.value;
  const stepped = await tenant.chooseCircleCIOrganization(
    caller.tenantId,
    caller.principalId,
    circleCIAuthorizationId,
    organizationId,
    now,
  );
  return answer(stepped, circleCIAuthorizationId, operation);
};
