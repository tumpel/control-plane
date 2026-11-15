import { verifyCircleCISignature, WorkflowCompletedSchema } from "./circleci.ts";
import { issues, problem } from "./http";
import type { Env } from "./index";

const EVENTS_PATH = /^\/v1\/circleci-events\/([^/]+)$/;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const forbidden = (): Response =>
  problem(403, {
    code: "Forbidden",
    title: "Signature mismatch",
    detail:
      "circleci-signature is missing or holds no v1 HMAC-SHA256 of the body under the signing secret of a binding behind this URL",
    fix: "Send events from the webhook tumpel circleci project add registered, to the URL it named; delete the binding and add it again to register a new secret",
  });

export const handleCircleCIEvents = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const route = EVENTS_PATH.exec(url.pathname);
  if (route === null || request.method !== "POST") return null;
  const tenantId = decodeURIComponent(route[1] ?? "");
  const body = await request.arrayBuffer();
  const event = WorkflowCompletedSchema.safeParse(parseJson(new TextDecoder().decode(body)));
  if (!event.success) {
    return problem(400, {
      code: "InvalidRequest",
      title: "Not a workflow-completed event",
      detail: `the CircleCI event does not parse: ${issues(event.error)}`,
      fix: "Send workflow-completed events in the shape CircleCI documents, with a workflow, a pipeline and a project",
    });
  }
  const tenant = await env.DB.prepare("SELECT 1 FROM tenants WHERE tenant_id = ?").bind(tenantId).first();
  if (tenant === null) return forbidden();
  const stub = env.TENANT.getByName(tenantId);
  const secret = await stub.circleCIWebhookSecret(event.data.project.id);
  if (secret === null || !(await verifyCircleCISignature(secret, body, request.headers.get("circleci-signature")))) {
    return forbidden();
  }
  await stub.circleCIWorkflowCompleted(tenantId, event.data, Date.now());
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
};
