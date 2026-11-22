import {
  BoxDiskLimit,
  BoxMemoryLimit,
  type ConfigFileDigestSchema,
  ConfigPlanSchema,
  ProblemResponseSchema,
  ProblemSchema,
  SecretValueSchema,
  type TenantConfigApplySchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { decodeBase64 } from "./channel/protocol.ts";
import {
  type ConfigPersona,
  type ConfigWrite,
  changeOf,
  type HarnessPinCreate,
  type Live,
  type Member,
  type PlannedFile,
  type PlanRequest,
  planOf,
  type ResolvedSet,
  type SecretMember,
  type SentFile,
  type Step,
  stopped,
  type TenantConfig,
  TRIGGER_STEPS,
} from "./configs.ts";
import { effectiveVersions } from "./harness-catalog.ts";
import { hostOf, listHosts, setHostLabels } from "./hosts.ts";
import { json, type Problem, problem } from "./http.ts";
import type { Caller } from "./identity.ts";
import type { Env } from "./index.ts";
import { ownerRequired } from "./members.ts";
import { type PersonaFileWrite, type StoredFile, sha256Hex } from "./persona-files.ts";
import { keyPrefixMismatch, unreadableSecretSet } from "./secret-members.ts";
import type { ConfigApplied } from "./tenant.ts";
import { tenantApi } from "./tenant-api.ts";
import { dropRoute, projectRoute } from "./trigger-routes.ts";
import { turnRefused } from "./triggers.ts";
import { personaFiles, pinRefusal, repositoryTokenUser } from "./write-checks.ts";

type ApplyRequest = z.infer<typeof TenantConfigApplySchema>;
type ConfigChange = ReturnType<typeof changeOf>;
type ConfigFileDigest = z.infer<typeof ConfigFileDigestSchema>;
type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response };

const missingValues = (steps: Step[], values: Map<string, string>): string[] =>
  steps.flatMap((step) => {
    if (step.kind !== "CreateSecretSet" && step.kind !== "UpdateSecretSet") return [];
    return step.secretSet.secrets
      .filter(({ secret }) => !values.has(secret.valueFrom.env))
      .map(
        ({ secret }) =>
          `secretValues holds no ${secret.valueFrom.env} (member ${secret.name} of secret set ${step.secretSet.name})`,
      );
  });

const secretValuesOf = (secretSet: ResolvedSet, values: Map<string, string>): SecretMember[] =>
  SecretValueSchema.array().parse(
    secretSet.secrets.map(({ secret, expiresAt }) => {
      const value = values.get(secret.valueFrom.env);
      if (secret.kind === "Variable") return { kind: "Variable", name: secret.name, value };
      if (secret.kind === "ApiKey") return { kind: "ApiKey", name: secret.name, provider: secret.provider, value };
      return { kind: "SubscriptionToken", name: secret.name, provider: secret.provider, expiresAt, value };
    }),
  );

const fileWrites = (files: PlannedFile[]): PersonaFileWrite[] =>
  files.map(({ file, held }) =>
    !held && file.content !== null
      ? { source: "Inline", path: file.path, content: file.content }
      : { source: "Stored", path: file.path, digest: file.digest, sizeBytes: file.sizeBytes },
  );

const refusedAt = async (answer: Response, change: ConfigChange, applied: ConfigChange[]): Promise<Response> => {
  const refusal: Problem = ProblemSchema.parse(await answer.json());
  const status = ProblemResponseSchema.shape.statusCode.safeParse(answer.status);
  const done =
    applied.length === 0
      ? "no change was applied"
      : `applied before it: ${applied.map((each) => each.description).join("; ")}`;
  return problem(status.success ? status.data : 422, {
    ...refusal,
    detail: `${change.description} was refused (${refusal.detail}); ${done}`,
  });
};

const OPERATION = "tenantConfigs.apply";

interface Prepare {
  env: Env;
  tenantId: string;
  principalId: string;
  values: Map<string, string>;
  setIds: Map<string, string>;
  members: Map<string, Member[]>;
  heldSets: Map<string, string>;
  connectorIds: Map<string, string>;
  pins: HarnessPinCreate[];
}

const connectorIdsOf = (prepare: Prepare, names: readonly string[]): string[] =>
  names.map((name) => {
    const connectorId = prepare.connectorIds.get(name);
    if (connectorId === undefined) throw new Error(`connector ${name} has no id after the plan held it`);
    return connectorId;
  });

const setIdOf = (prepare: Prepare, name: string): string => {
  const secretSetId = prepare.setIds.get(name);
  if (secretSetId === undefined) throw new Error(`secret set ${name} has no id after the plan held it`);
  return secretSetId;
};

const membersOf = (prepare: Prepare, name: string): Member[] => {
  const members = prepare.members.get(name);
  if (members === undefined) throw new Error(`secret set ${name} has no members after the plan held it`);
  return members;
};

const checkedFiles = (
  prepare: Prepare,
  persona: ConfigPersona,
  files: PlannedFile[],
  newSecretSet: boolean,
): Promise<Outcome<StoredFile[]>> =>
  personaFiles(
    prepare.env,
    prepare.tenantId,
    {
      harness: persona.harness,
      files: fileWrites(files),
      secretSetName: persona.secretSetName,
      members: membersOf(prepare, persona.secretSetName),
      pins: prepare.pins,
      newSecretSet,
    },
    OPERATION,
  );

const labelRefusal = async (prepare: Prepare, hostId: string): Promise<Response | null> => {
  const host = await hostOf(prepare.env.DB, prepare.tenantId, hostId);
  if (host !== null && host.state !== "Revoked") return null;
  return problem(409, {
    code: "Conflict",
    title: "Host gone during apply",
    detail: `host ${hostId} was revoked or removed after the plan read it`,
    fix: "Run tumpel config plan again, then apply",
  });
};

const writeOf = async (step: Step, prepare: Prepare): Promise<Outcome<ConfigWrite | null>> => {
  switch (step.kind) {
    case "CreateSecretSet":
    case "UpdateSecretSet":
    case "RewriteSecretSet": {
      const secrets = secretValuesOf(step.secretSet, prepare.values);
      const mismatch = keyPrefixMismatch(secrets, OPERATION);
      if (mismatch !== null) return { ok: false, response: problem(422, mismatch) };
      const user = await repositoryTokenUser(prepare.env, secrets, OPERATION);
      if (!user.ok) return user;
      return {
        ok: true,
        value: {
          kind: step.kind === "CreateSecretSet" ? "CreateSecretSet" : "RewriteSecretSet",
          secretSetId: setIdOf(prepare, step.secretSet.name),
          secretSet: { name: step.secretSet.name, secrets },
          githubUser: user.user,
        },
      };
    }
    case "DeleteSecretSet":
      return { ok: true, value: { kind: "DeleteSecretSet", secretSetId: step.secretSetId } };
    case "CreatePersona": {
      const files = await checkedFiles(prepare, step.persona, step.files, true);
      if (!files.ok) return files;
      const secretSetId = setIdOf(prepare, step.persona.secretSetName);
      return {
        ok: true,
        value: {
          kind: "CreatePersona",
          persona: {
            name: step.persona.name,
            harness: step.persona.harness,
            secretSetId,
            connectorIds: connectorIdsOf(prepare, step.persona.connectorNames),
            boxMemoryMib: step.persona.boxMemoryMib ?? BoxMemoryLimit.DefaultMib,
            boxDiskMib: step.persona.boxDiskMib ?? BoxDiskLimit.DefaultMib,
            boxRetention: step.persona.boxRetention ?? "Auto",
            tumpelMcp: step.persona.tumpelMcp ?? false,
            files: files.value,
          },
        },
      };
    }
    case "UpdatePersona": {
      const secretSetId = setIdOf(prepare, step.persona.secretSetName);
      const newSecretSet = prepare.heldSets.get(step.personaId) !== secretSetId;
      const files = await checkedFiles(prepare, step.persona, step.files, newSecretSet);
      if (!files.ok) return files;
      return {
        ok: true,
        value: {
          kind: "UpdatePersona",
          personaId: step.personaId,
          persona: {
            name: step.persona.name,
            secretSetId,
            connectorIds: connectorIdsOf(prepare, step.persona.connectorNames),
            boxMemoryMib: step.persona.boxMemoryMib ?? BoxMemoryLimit.DefaultMib,
            boxDiskMib: step.persona.boxDiskMib ?? BoxDiskLimit.DefaultMib,
            boxRetention: step.persona.boxRetention ?? "Auto",
            tumpelMcp: step.persona.tumpelMcp ?? false,
            files: files.value,
          },
        },
      };
    }
    case "DeletePersona":
      return { ok: true, value: { kind: "DeletePersona", personaId: step.personaId } };
    case "CreatePin":
    case "UpdatePin": {
      const refused = await pinRefusal(prepare.env, prepare.tenantId, step.pin);
      if (refused !== null) return { ok: false, response: refused };
      return { ok: true, value: { kind: "Pin", pin: step.pin } };
    }
    case "DeletePin":
      return { ok: true, value: { kind: "Unpin", harness: step.harness } };
    case "LabelHost": {
      const refused = await labelRefusal(prepare, step.host.hostId);
      if (refused !== null) return { ok: false, response: refused };
      return { ok: true, value: null };
    }
    case "CreateTrigger":
      return { ok: true, value: { kind: "CreateTrigger", trigger: step.trigger, principalId: prepare.principalId } };
    case "UpdateTrigger":
      return {
        ok: true,
        value: {
          kind: "UpdateTrigger",
          triggerId: step.triggerId,
          trigger: step.trigger,
          principalId: prepare.principalId,
        },
      };
    case "DeleteTrigger":
      return { ok: true, value: { kind: "DeleteTrigger", triggerId: step.triggerId } };
  }
};

const prepared = async (
  steps: Step[],
  live: Live,
  config: TenantConfig,
  values: Map<string, string>,
  env: Env,
  caller: Caller,
): Promise<Outcome<ConfigWrite[]>> => {
  const { tenantId, principalId } = caller;
  const prepare: Prepare = {
    env,
    tenantId,
    principalId,
    values,
    setIds: new Map(live.secretSets.map((set) => [set.name, set.secretSetId])),
    members: new Map(live.secretSets.map((set) => [set.name, set.keys])),
    heldSets: new Map(live.personas.map((persona) => [persona.personaId, persona.secretSetId])),
    connectorIds: new Map(live.connectors.map((connector) => [connector.name, connector.connectorId])),
    pins: config.harnessPins,
  };
  for (const step of steps) {
    if (step.kind === "CreateSecretSet") prepare.setIds.set(step.secretSet.name, crypto.randomUUID());
    if (step.kind === "CreateSecretSet" || step.kind === "UpdateSecretSet" || step.kind === "RewriteSecretSet") {
      prepare.members.set(step.secretSet.name, secretValuesOf(step.secretSet, values));
    }
  }
  const writes: ConfigWrite[] = [];
  for (const step of steps) {
    const write = await writeOf(step, prepare);
    if (!write.ok) return { ok: false, response: await refusedAt(write.response, changeOf(step), []) };
    if (write.value !== null) writes.push(write.value);
  }
  return { ok: true, value: writes };
};
const readLive = async (env: Env, tenantId: string, operation: string): Promise<Outcome<Live>> => {
  const api = tenantApi(env.TENANT, tenantId);
  const { read: secretSets } = await api.call("listSecretSets", { tenantId });
  if (secretSets.kind === "Unreadable") {
    return { ok: false, response: problem(409, unreadableSecretSet(operation, secretSets)) };
  }
  return {
    ok: true,
    value: {
      personas: (await api.call("listPersonas", { tenantId })).personas,
      connectors: (await api.call("listConnectors", { tenantId, now: Date.now() })).connectors.map(
        ({ connectorId, name }) => ({
          connectorId,
          name,
        }),
      ),
      secretSets: secretSets.secretSets,
      pins: effectiveVersions((await api.call("listPins", {})).pins),
      hosts: await listHosts(env, tenantId),
      sessions: (await api.call("listSessions", { tenantId, filter: {} })).sessions,
      triggers: (await api.call("listTriggers", { tenantId })).triggers,
    },
  };
};

const digestFiles = (files: ConfigFileDigest[]): Map<string, SentFile> =>
  new Map(files.map((file) => [file.from, { digest: file.digest, sizeBytes: file.sizeBytes, content: null }]));

const writtenFiles = async (files: ApplyRequest["files"], problems: string[]): Promise<Map<string, SentFile>> => {
  const sent = new Map<string, SentFile>();
  for (const file of files) {
    if (file.source === "Stored") {
      sent.set(file.from, { digest: file.digest, sizeBytes: file.sizeBytes, content: null });
      continue;
    }
    const bytes = decodeBase64(file.content);
    if (bytes === null) {
      problems.push(`the content of ${file.from} is not base64; send the file's bytes base64-encoded`);
      continue;
    }
    sent.set(file.from, { digest: await sha256Hex(bytes), sizeBytes: bytes.byteLength, content: file.content });
  }
  return sent;
};

export const planConfig = async (body: PlanRequest, env: Env, caller: Caller): Promise<Response> => {
  const live = await readLive(env, caller.tenantId, "tenantConfigs.plan");
  if (!live.ok) return live.response;
  const planned = planOf(
    {
      config: body.config,
      files: digestFiles(body.files),
      expiryValues: body.expiryValues,
      secretEnvs: new Set(body.secretValues.map((each) => each.env)),
    },
    live.value,
  );
  if (!planned.ok) return stopped(planned.problems);
  return json(ConfigPlanSchema.parse({ changes: planned.steps.map(changeOf) }));
};

const committed = (applied: ConfigApplied): Response | null => {
  if (applied.kind === "Applied") return null;
  const broke =
    applied.kind === "Conflict"
      ? `broke the constraint ${applied.constraint}, which a change made while it ran now holds`
      : `found ${applied.resource} deleted while it ran`;
  return problem(409, {
    code: "Conflict",
    title: "Tenant changed during apply",
    detail: `${OPERATION} ${broke}; nothing was changed`,
    fix: "Run tumpel config plan again, then apply",
  });
};

const projectRoutes = async (env: Env, tenantId: string, steps: Step[]): Promise<void> => {
  const { triggers } = await tenantApi(env.TENANT, tenantId).call("listTriggers", { tenantId });
  for (const trigger of triggers) await projectRoute(env.DB, trigger);
  for (const step of steps) if (step.kind === "DeleteTrigger") await dropRoute(env.DB, tenantId, step.triggerId);
};

export const applyConfig = async (body: ApplyRequest, env: Env, caller: Caller): Promise<Response> => {
  const { tenantId } = caller;
  const problems: string[] = [];
  const files = await writtenFiles(body.files, problems);
  if (problems.length > 0) return stopped(problems);
  const live = await readLive(env, tenantId, OPERATION);
  if (!live.ok) return live.response;
  const values = new Map(body.secretValues.map((each) => [each.env, each.value]));
  const planned = planOf(
    { config: body.config, files, expiryValues: body.expiryValues, secretEnvs: new Set(values.keys()) },
    live.value,
  );
  if (!planned.ok) return stopped(planned.problems);
  const missing = missingValues(planned.steps, values);
  if (missing.length > 0) return stopped(missing);
  const touchesTriggers = planned.steps.some((step) => TRIGGER_STEPS.includes(step.kind));
  const forbidden = touchesTriggers ? (turnRefused(caller, OPERATION) ?? ownerRequired(caller, OPERATION)) : null;
  if (forbidden !== null) return forbidden;
  const writes = await prepared(planned.steps, live.value, body.config, values, env, caller);
  if (!writes.ok) return writes.response;
  const refused = committed(
    (await tenantApi(env.TENANT, tenantId).call("applyConfig", { tenantId, writes: writes.value, now: Date.now() }))
      .applied,
  );
  if (refused !== null) return refused;
  if (body.config.triggers !== undefined) await projectRoutes(env, tenantId, planned.steps);
  const applied = planned.steps.filter((step) => step.kind !== "LabelHost").map(changeOf);
  for (const step of planned.steps) {
    if (step.kind !== "LabelHost") continue;
    const change = changeOf(step);
    const labelled = await setHostLabels(env.DB, tenantId, step.host.hostId, step.host.labels, Date.now());
    if (!labelled.ok) return refusedAt(problem(labelled.status, labelled.problem), change, applied);
    applied.push(change);
  }
  return json(ConfigPlanSchema.parse({ changes: applied }));
};
