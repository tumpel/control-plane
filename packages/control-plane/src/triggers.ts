import {
  TriggerCreateSchema,
  type TriggerFiredInputSchema,
  TriggerPatchSchema,
  TriggerPathSchema,
  TriggerTestResultSchema,
  TriggerTestSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import type { Refused } from "./http.ts";
import { json, noContent, parseBody, problem } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { Env } from "./index.ts";
import { ownerRequired } from "./members.ts";
import { startable, startTarget } from "./sessions.ts";
import { tenantApi } from "./tenant-api.ts";
import { TARGETS_PER_SESSION, TARGETS_PER_TENANT, type Trigger } from "./tenant-triggers.ts";
import { fillPrompt, matches, verdicts } from "./trigger-match.ts";
import { dropRoute, matchedTriggers, projectRoute } from "./trigger-routes.ts";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;
type TriggerCreate = z.infer<typeof TriggerCreateSchema>;
type Fired = z.infer<typeof TriggerFiredInputSchema>["fired"];
type TriggerTestResult = z.infer<typeof TriggerTestResultSchema>;

const TRIGGERS_PATH = "/v1/triggers";
const TEST_PATH = "/v1/triggers/test";
const TRIGGER_PATH = /^\/v1\/triggers\/([^/]+)$/;

export const turnRefused = (caller: Caller, operation: string): Response | null =>
  caller.origin.kind !== "Turn"
    ? null
    : problem(403, {
        code: "Forbidden",
        title: "Only a person can do this",
        detail: `${operation} refuses calls from inside a tumpel session; only an Owner creates, changes or deletes a trigger`,
        fix: "Tell your person what the trigger must do, and let an Owner set it up",
      });

const writeRefused = (caller: Caller, operation: string): Response | null =>
  turnRefused(caller, operation) ?? ownerRequired(caller, operation);

const targetRefused = (caller: Caller, sessionId: string | undefined, operation: string): Response | null => {
  if (caller.origin.kind !== "Turn") return ownerRequired(caller, operation);
  if (sessionId === caller.origin.sessionId) return null;
  return problem(403, {
    code: "Forbidden",
    title: "Only your own session",
    detail: `${operation} from inside tumpel session ${caller.origin.sessionId} takes only a trigger targeting that session`,
    fix: `Set sessionId to ${caller.origin.sessionId}, or tell your person what the trigger must do and let an Owner set it up`,
  });
};

const targetNotFound = (sessionId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such session",
    detail: `your tenant has no session ${sessionId} to target`,
    fix: "List your sessions and target one of their ids",
  });

const targetEnded = (sessionId: string, state: "Archived" | "Failed"): Response =>
  problem(409, {
    code: state === "Archived" ? "SessionArchived" : "SessionFailed",
    title: `Session ${state.toLowerCase()}`,
    detail: `session ${sessionId} is ${state} and takes no more turns, so no trigger can target it`,
    fix: "Target a session that is still running, or start a new one",
  });

const sessionMismatch = (sessionId: string, session: { personaId: string; model: string }): Response =>
  problem(400, {
    code: "InvalidRequest",
    title: "Trigger differs from its session",
    detail: `session ${sessionId} runs persona ${session.personaId} with model ${session.model}, and a trigger targeting it must name the same`,
    fix: `Set personaId to ${session.personaId} and model to ${session.model}`,
  });

const limitReached = (sessionId: string, scope: string): Response =>
  problem(409, {
    code: "TriggerLimitReached",
    title: "Too many targeted triggers",
    detail:
      scope === "Session"
        ? `session ${sessionId} already has ${TARGETS_PER_SESSION} targeted triggers, the most one session may have`
        : `your tenant already has ${TARGETS_PER_TENANT} targeted triggers, the most one tenant may have`,
    fix: "Delete a targeted trigger you no longer wait on, then create this one again",
  });

const targetedImmutable = (triggerId: string): Response =>
  problem(400, {
    code: "InvalidRequest",
    title: "Targeted trigger is immutable",
    detail: `trigger ${triggerId} targets a session, and a targeted trigger never changes`,
    fix: "Delete the trigger and create a new one",
  });

const notFound = (triggerId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such trigger",
    detail: `your tenant has no trigger ${triggerId}`,
    fix: "List your triggers with tumpel trigger list and use one of their ids",
  });

const personaNotFound = (personaId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such persona",
    detail: `your tenant owns no persona ${personaId}`,
    fix: "List your personas and name one of their ids",
  });

const nameTaken = (name: string): Response =>
  problem(409, {
    code: "Conflict",
    title: "Trigger name taken",
    detail: `your tenant already has a trigger named ${name}`,
    fix: "Give the trigger another name, or change the existing one",
  });

const unstartable = async (
  env: Env,
  caller: Caller,
  trigger: Pick<Trigger, "personaId" | "model">,
  operation: string,
): Promise<Response | null> => {
  const checked = await startable(env, caller.tenantId, trigger.personaId, trigger.model, operation, Date.now());
  return checked.ok ? null : problem(checked.status, checked.problem);
};

const create = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  const body = await parseBody(request, TriggerCreateSchema, "triggers.create");
  if (!body.ok) return body.response;
  const trigger = body.value;
  const { sessionId } = trigger;
  const refused = targetRefused(caller, sessionId, "triggers.create");
  if (refused !== null) return refused;
  const unusable = await unstartable(env, caller, trigger, "triggers.create");
  if (unusable !== null) return unusable;
  const { tenantId, principalId } = caller;
  const { created } = await tenantApi(env.TENANT, tenantId).call("createTrigger", {
    tenantId,
    trigger,
    principalId,
    now: Date.now(),
  });
  if (created.kind === "NameTaken") return nameTaken(trigger.name);
  if (created.kind === "PersonaNotFound") return personaNotFound(trigger.personaId);
  if (created.kind !== "Created") {
    const target = sessionId ?? "";
    if (created.kind === "NotFound") return targetNotFound(target);
    if (created.kind === "SessionMismatch") return sessionMismatch(target, created);
    if (created.kind === "LimitReached") return limitReached(target, created.scope);
    return targetEnded(target, created.kind);
  }
  await projectRoute(env.DB, created.trigger);
  return json(created.trigger);
};

const update = async (request: Request, env: Env, caller: Caller, current: Trigger): Promise<Response> => {
  const refused = writeRefused(caller, "triggers.update");
  if (refused !== null) return refused;
  if (current.sessionId !== undefined) return targetedImmutable(current.triggerId);
  const body = await parseBody(request, TriggerPatchSchema, "triggers.update");
  if (!body.ok) return body.response;
  const patch = body.value;
  const unusable = await unstartable(env, caller, { ...current, ...patch }, "triggers.update");
  if (unusable !== null) return unusable;
  const { tenantId, principalId } = caller;
  const { triggerId } = current;
  const { updated } = await tenantApi(env.TENANT, tenantId).call("updateTrigger", {
    tenantId,
    triggerId,
    patch,
    principalId,
    now: Date.now(),
  });
  if (updated.kind === "NotFound") return notFound(triggerId);
  if (updated.kind === "NameTaken") return nameTaken(patch.name ?? current.name);
  if (updated.kind === "PersonaNotFound") return personaNotFound(patch.personaId ?? current.personaId);
  if (updated.kind === "Targeted") return targetedImmutable(triggerId);
  await projectRoute(env.DB, updated.trigger);
  return json(updated.trigger);
};

const remove = async (env: Env, caller: Caller, triggerId: string): Promise<Response> => {
  const { tenantId } = caller;
  if (caller.origin.kind === "Turn") {
    const { trigger } = await tenantApi(env.TENANT, tenantId).call("getTrigger", { tenantId, triggerId });
    if (trigger === null) return notFound(triggerId);
    const refused = targetRefused(caller, trigger.sessionId, "triggers.delete");
    if (refused !== null) return refused;
  } else {
    const refused = ownerRequired(caller, "triggers.delete");
    if (refused !== null) return refused;
  }
  const { deleted } = await tenantApi(env.TENANT, tenantId).call("deleteTrigger", {
    tenantId,
    triggerId,
    now: Date.now(),
  });
  if (!deleted) return notFound(triggerId);
  await dropRoute(env.DB, tenantId, triggerId);
  return noContent();
};

const tryOn = (trigger: TriggerCreate, payload: unknown): TriggerTestResult => {
  const conditions = verdicts(trigger.source.conditions, payload);
  return TriggerTestResultSchema.parse({
    matched: conditions.every((condition) => condition.holds),
    conditions,
    ...fillPrompt(trigger.prompt, payload),
  });
};

const test = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  const body = await parseBody(request, TriggerTestSchema, "triggers.test");
  if (!body.ok) return body.response;
  const tested = body.value;
  if (tested.kind === "Draft") return json(tryOn(tested.trigger, tested.payload));
  const { tenantId } = caller;
  const { triggerId } = tested;
  const { trigger } = await tenantApi(env.TENANT, tenantId).call("getTrigger", { tenantId, triggerId });
  if (trigger === null) return notFound(triggerId);
  return json(tryOn(trigger, tested.payload));
};

const one = async (request: Request, env: Env, caller: Caller, triggerId: string): Promise<Response> => {
  if (request.method === "DELETE") return remove(env, caller, triggerId);
  const { tenantId } = caller;
  const { trigger } = await tenantApi(env.TENANT, tenantId).call("getTrigger", { tenantId, triggerId });
  if (trigger === null) return notFound(triggerId);
  if (request.method === "PATCH") return update(request, env, caller, trigger);
  return json(trigger);
};

export const handleTriggers = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const { pathname } = url;
  const { method } = request;
  const listing = pathname === TRIGGERS_PATH && (method === "GET" || method === "POST");
  const testing = pathname === TEST_PATH && method === "POST";
  const match = testing ? null : TRIGGER_PATH.exec(pathname);
  const single = match !== null && ["GET", "PATCH", "DELETE"].includes(method);
  if (!listing && !testing && !single) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (testing) return test(request, env, caller);
  if (listing && method === "POST") return create(request, env, caller);
  if (listing) {
    const { tenantId } = caller;
    return json((await tenantApi(env.TENANT, tenantId).call("listTriggers", { tenantId })).triggers);
  }
  const raw = decodeURIComponent(match?.[1] ?? "");
  const path = TriggerPathSchema.safeParse({ triggerId: raw });
  if (!path.success) return notFound(raw);
  return one(request, env, caller, path.data.triggerId);
};

const refusal = (refused: Refused): Fired => ({
  kind: "Refused",
  refusal: { code: refused.problem.code, detail: `${refused.problem.detail}. ${refused.problem.fix}` },
});

const matchedOf = (trigger: Trigger, payload: unknown, repository: string): Fired => {
  const { prompt, missingFields } = fillPrompt(trigger.prompt, payload);
  if (missingFields.length > 0) {
    return {
      kind: "Refused",
      refusal: {
        code: "TriggerFieldMissing",
        detail: `the ${trigger.source.event} event lacks ${missingFields.join(", ")}, which the prompt of trigger ${trigger.name} names. Test the trigger on a payload of the event and fix the placeholder`,
      },
    };
  }
  const target = startTarget(repository);
  if (!target.ok) return refusal(target);
  return { kind: "Matched", repository: target.value, prompt };
};

export interface Delivery {
  tenantId: string;
  event: string;
  deliveryId: string;
  repository: string;
  payload: unknown;
}

export const fireTriggers = async (env: Env, delivery: Delivery): Promise<void> => {
  const { tenantId, deliveryId } = delivery;
  const tenant = tenantApi(env.TENANT, tenantId);
  for (const triggerId of await matchedTriggers(env.DB, tenantId, "GitHub", delivery.event, delivery.payload)) {
    const { trigger } = await tenant.call("getTrigger", { tenantId, triggerId });
    if (trigger === null) {
      await dropRoute(env.DB, tenantId, triggerId);
      continue;
    }
    const { source } = trigger;
    if (source.event !== delivery.event || !matches(source.conditions, delivery.payload)) {
      await projectRoute(env.DB, trigger);
      continue;
    }
    const fired = matchedOf(trigger, delivery.payload, delivery.repository);
    const answer = await tenant.call("triggerFired", { tenantId, triggerId, deliveryId, fired, now: Date.now() });
    if (answer.fired.kind === "NotFound") await dropRoute(env.DB, tenantId, triggerId);
  }
};
