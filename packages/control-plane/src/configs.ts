import {
  type ConfigChangeSchema,
  type ConfigFileDigestSchema,
  ConfigPlanSchema,
  type ConfigSecretSetSchema,
  EffectiveHarnessVersionSchema,
  HostSchema,
  PersonaFileLimit,
  PersonaSchema,
  ProblemResponseSchema,
  ProblemSchema,
  SecretSetSchema,
  SessionSchema,
  type TenantConfigApplySchema,
  type TenantConfigPlanRequestSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { decodeBase64 } from "./channel/protocol.ts";
import { json, type Problem, problem } from "./http.ts";
import { type PersonaFileWrite, sha256Hex } from "./persona-files.ts";

type PlanRequest = z.infer<typeof TenantConfigPlanRequestSchema>;
type ApplyRequest = z.infer<typeof TenantConfigApplySchema>;
type TenantConfig = PlanRequest["config"];
type ConfigFileDigest = z.infer<typeof ConfigFileDigestSchema>;
type ConfigPersona = TenantConfig["personas"][number];
type ConfigSecretSet = z.infer<typeof ConfigSecretSetSchema>;
type ConfigSecret = ConfigSecretSet["secrets"][number];
type ConfigHost = TenantConfig["hosts"][number];
type HarnessPinCreate = TenantConfig["harnessPins"][number];
type ConfigChange = z.infer<typeof ConfigChangeSchema>;
type Persona = z.infer<typeof PersonaSchema>;
type SecretSet = z.infer<typeof SecretSetSchema>;
type SecretKey = SecretSet["keys"][number];
type Pin = z.infer<typeof EffectiveHarnessVersionSchema>;
type Host = z.infer<typeof HostSchema>;
type Session = z.infer<typeof SessionSchema>;

export type Call = (method: string, path: string, body: unknown) => Promise<Response>;

export interface Live {
  personas: Persona[];
  secretSets: SecretSet[];
  pins: Pin[];
  hosts: Host[];
  sessions: Session[];
}

interface LocalFile {
  path: string;
  digest: string;
  sizeBytes: number;
  content: string | null;
}

export interface SentFile {
  digest: string;
  sizeBytes: number;
  content: string | null;
}

interface PlannedFile {
  file: LocalFile;
  held: boolean;
}

type ResolvedSecret = { secret: ConfigSecret; expiresAt: string | null };

interface ResolvedSet {
  name: string;
  secrets: ResolvedSecret[];
}

export type Step =
  | { kind: "CreatePersona"; persona: ConfigPersona; files: PlannedFile[] }
  | { kind: "UpdatePersona"; personaId: string; persona: ConfigPersona; files: PlannedFile[]; removed: string[] }
  | { kind: "DeletePersona"; personaId: string; name: string }
  | { kind: "CreateSecretSet"; secretSet: ResolvedSet }
  | { kind: "UpdateSecretSet"; secretSetId: string; secretSet: ResolvedSet }
  | { kind: "RewriteSecretSet"; secretSetId: string; secretSet: ResolvedSet }
  | { kind: "DeleteSecretSet"; secretSetId: string; name: string }
  | { kind: "CreatePin"; pin: HarnessPinCreate }
  | { kind: "UpdatePin"; pin: HarnessPinCreate; from: string }
  | { kind: "DeletePin"; harness: string }
  | { kind: "LabelHost"; host: ConfigHost };

type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response };

const stopped = (problems: string[]): Response =>
  problem(422, {
    code: "InvalidRequest",
    title: "Config plan stopped",
    detail: problems.join("; "),
    fix: "Fix each problem named in the config or in the values and files sent with it, then apply again; nothing was changed",
  });

const memberName = (secret: ConfigSecret): string => secret.name;

const describeSecret = ({ secret, expiresAt }: ResolvedSecret): string => {
  if (secret.kind === "Variable") return `${secret.name} (Variable)`;
  if (secret.kind === "ApiKey") return `${secret.name} (ApiKey for ${secret.provider})`;
  return `${secret.name} (SubscriptionToken for ${secret.provider}, expires ${expiresAt})`;
};

const secretIdentity = ({ secret, expiresAt }: ResolvedSecret): string => {
  if (secret.kind === "Variable") return `Variable ${secret.name}`;
  if (secret.kind === "ApiKey") return `ApiKey ${secret.name} ${secret.provider}`;
  return `SubscriptionToken ${secret.name} ${secret.provider} ${Date.parse(expiresAt ?? "")}`;
};

const keyIdentity = (key: SecretKey): string => {
  if (key.kind === "Variable") return `Variable ${key.name}`;
  if (key.kind === "ApiKey") return `ApiKey ${key.name} ${key.provider}`;
  return `SubscriptionToken ${key.name} ${key.provider} ${Date.parse(key.expiresAt)}`;
};

const keyList = (secretSet: ResolvedSet): string =>
  secretSet.secrets.map((each) => `${describeSecret(each)} from $${each.secret.valueFrom.env}`).join(", ");

const fileList = (files: PlannedFile[], removed: string[]): string => {
  const changed = [
    ...files
      .filter((planned) => !planned.held)
      .map((planned) => `write ${planned.file.path} (${planned.file.sizeBytes} bytes, sha256 ${planned.file.digest})`),
    ...removed.map((path) => `delete ${path}`),
  ];
  return changed.length === 0 ? "" : `; files: ${changed.join(", ")}`;
};

const changeOf = (step: Step): ConfigChange => {
  switch (step.kind) {
    case "CreatePersona":
      return {
        action: "Create",
        resource: "Persona",
        name: step.persona.name,
        description: `create persona ${step.persona.name} running ${step.persona.harness} on secret set ${step.persona.secretSetName}${fileList(step.files, [])}`,
      };
    case "UpdatePersona":
      return {
        action: "Update",
        resource: "Persona",
        name: step.persona.name,
        description: `update persona ${step.persona.name} (${step.personaId}) running ${step.persona.harness} on secret set ${step.persona.secretSetName}${fileList(step.files, step.removed)}`,
      };
    case "DeletePersona":
      return {
        action: "Delete",
        resource: "Persona",
        name: step.name,
        description: `delete persona ${step.name} (${step.personaId})`,
      };
    case "CreateSecretSet":
      return {
        action: "Create",
        resource: "SecretSet",
        name: step.secretSet.name,
        description: `create secret set ${step.secretSet.name}: ${keyList(step.secretSet)}`,
      };
    case "UpdateSecretSet":
      return {
        action: "Update",
        resource: "SecretSet",
        name: step.secretSet.name,
        description: `update secret set ${step.secretSet.name} (${step.secretSetId}): ${keyList(step.secretSet)}`,
      };
    case "RewriteSecretSet":
      return {
        action: "Rewrite",
        resource: "SecretSet",
        name: step.secretSet.name,
        description: `rewrite secret set ${step.secretSet.name} (${step.secretSetId}): ${keyList(step.secretSet)}`,
      };
    case "DeleteSecretSet":
      return {
        action: "Delete",
        resource: "SecretSet",
        name: step.name,
        description: `delete secret set ${step.name} (${step.secretSetId})`,
      };
    case "CreatePin":
      return {
        action: "Create",
        resource: "HarnessPin",
        name: step.pin.harness,
        description: `create pin ${step.pin.harness} ${step.pin.harnessVersion}`,
      };
    case "UpdatePin":
      return {
        action: "Update",
        resource: "HarnessPin",
        name: step.pin.harness,
        description: `update pin ${step.pin.harness} ${step.from} -> ${step.pin.harnessVersion}`,
      };
    case "DeletePin":
      return {
        action: "Delete",
        resource: "HarnessPin",
        name: step.harness,
        description: `delete pin ${step.harness}`,
      };
    case "LabelHost":
      return {
        action: "Update",
        resource: "Host",
        name: step.host.hostId,
        description: `update host ${step.host.hostId} labels: [${step.host.labels.join(", ")}]`,
      };
  }
};

const duplicates = (names: string[]): string[] => [
  ...new Set(names.filter((name, index) => names.indexOf(name) !== index)),
];

const checkUnique = (problems: string[], what: string, names: string[], fix: string): void => {
  for (const name of duplicates(names)) problems.push(`${what} ${JSON.stringify(name)} appears more than once; ${fix}`);
};

const resolveSets = (config: TenantConfig, expiries: Map<string, string>, problems: string[]): ResolvedSet[] =>
  config.secretSets.map((secretSet) => ({
    name: secretSet.name,
    secrets: secretSet.secrets.map((secret) => {
      if (secret.kind !== "SubscriptionToken") return { secret, expiresAt: null };
      if (typeof secret.expiresAt === "string") return { secret, expiresAt: secret.expiresAt };
      const env = secret.expiresAt.env;
      const expiresAt = expiries.get(env);
      if (expiresAt === undefined) {
        problems.push(
          `expiryValues holds no ${env}; member ${secret.name} of secret set ${secretSet.name} reads its expiresAt from it, so send the token's expiry as an ISO 8601 date-time with an offset`,
        );
        return { secret, expiresAt: null };
      }
      return { secret, expiresAt };
    }),
  }));

const readBundles = (
  config: TenantConfig,
  sent: Map<string, SentFile>,
  problems: string[],
): Map<string, LocalFile[]> => {
  const bundles = new Map<string, LocalFile[]>();
  for (const persona of config.personas) {
    const files: LocalFile[] = [];
    for (const file of persona.files) {
      const found = sent.get(file.from);
      if (found === undefined) {
        problems.push(`files holds no ${file.from}; persona ${persona.name} puts it at ${file.path}, so send it`);
        continue;
      }
      files.push({ path: file.path, ...found });
    }
    const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > PersonaFileLimit.PersonaBytes) {
      problems.push(
        `persona ${JSON.stringify(persona.name)} holds ${total} bytes of files, over the ${PersonaFileLimit.PersonaBytes}-byte cap on a persona; trim the files or split them across personas`,
      );
    }
    bundles.set(persona.name, files);
  }
  return bundles;
};

const planSecretSets = (
  desired: ResolvedSet[],
  live: SecretSet[],
  sent: Set<string>,
  steps: Step[],
  problems: string[],
): void => {
  const byName = new Map(live.map((set) => [set.name, set]));
  for (const secretSet of desired) {
    const current = byName.get(secretSet.name);
    if (current === undefined) {
      steps.push({ kind: "CreateSecretSet", secretSet });
      continue;
    }
    const wanted = new Set(secretSet.secrets.map(secretIdentity));
    const held = new Set(current.keys.map(keyIdentity));
    const same = wanted.size === held.size && [...wanted].every((key) => held.has(key));
    if (!same) {
      steps.push({ kind: "UpdateSecretSet", secretSetId: current.secretSetId, secretSet });
      continue;
    }
    const envs = secretSet.secrets.map(({ secret }) => secret.valueFrom.env);
    const missing = envs.filter((env) => !sent.has(env));
    if (missing.length === envs.length) continue;
    if (missing.length > 0) {
      problems.push(
        `secret set ${secretSet.name} is rewritten only with every value it names, and secretValues holds no ${missing.join(", ")}; send all of ${envs.join(", ")} to rewrite it, or none to keep its values`,
      );
      continue;
    }
    steps.push({ kind: "RewriteSecretSet", secretSetId: current.secretSetId, secretSet });
  }
};

const planPersonas = (
  desired: ConfigPersona[],
  bundles: Map<string, LocalFile[]>,
  live: Live,
  steps: Step[],
  problems: string[],
): void => {
  const byName = new Map(live.personas.map((persona) => [persona.name, persona]));
  const setIds = new Map(live.secretSets.map((set) => [set.name, set.secretSetId]));
  for (const persona of desired) {
    const local = bundles.get(persona.name) ?? [];
    const current = byName.get(persona.name);
    if (current === undefined) {
      steps.push({ kind: "CreatePersona", persona, files: local.map((file) => ({ file, held: false })) });
      continue;
    }
    if (current.harness !== persona.harness) {
      problems.push(
        `persona ${JSON.stringify(persona.name)} runs ${current.harness}, and a persona's harness is fixed when it is created; give the ${persona.harness} persona a new name, or delete ${JSON.stringify(persona.name)} first`,
      );
      continue;
    }
    const held = new Map(current.files.map((file) => [file.path, file.digest]));
    const files = local.map((file) => ({ file, held: held.get(file.path) === file.digest }));
    const wanted = new Set(local.map((file) => file.path));
    const removed = [...held.keys()].filter((path) => !wanted.has(path)).sort();
    const unchanged =
      setIds.get(persona.secretSetName) === current.secretSetId &&
      removed.length === 0 &&
      files.every((file) => file.held);
    if (!unchanged) {
      steps.push({ kind: "UpdatePersona", personaId: current.personaId, persona, files, removed });
    }
  }
};

const planPersonaDeletes = (desired: ConfigPersona[], live: Live, steps: Step[], problems: string[]): void => {
  const wanted = new Set(desired.map((persona) => persona.name));
  for (const persona of live.personas.filter((each) => !wanted.has(each.name))) {
    const ran = live.sessions
      .filter((session) => session.personaId === persona.personaId && session.lastTurnState !== "Failed")
      .map((session) => session.sessionId);
    if (ran.length > 0) {
      problems.push(
        `delete persona ${persona.name} (${persona.personaId}) will be refused: it is the persona of session ${ran.join(", ")}, and a persona that completed a turn stays; keep the persona in the config`,
      );
      continue;
    }
    steps.push({ kind: "DeletePersona", personaId: persona.personaId, name: persona.name });
  }
};

const planSecretSetDeletes = (desired: ResolvedSet[], live: SecretSet[], steps: Step[]): void => {
  const wanted = new Set(desired.map((set) => set.name));
  for (const secretSet of live.filter((set) => !wanted.has(set.name))) {
    steps.push({ kind: "DeleteSecretSet", secretSetId: secretSet.secretSetId, name: secretSet.name });
  }
};

const planPins = (desired: HarnessPinCreate[], live: Pin[], steps: Step[]): void => {
  const pinned = new Map(live.filter((pin) => pin.pinned).map((pin) => [pin.harness, pin]));
  for (const pin of desired) {
    const current = pinned.get(pin.harness);
    if (current === undefined) steps.push({ kind: "CreatePin", pin });
    else if (current.harnessVersion !== pin.harnessVersion) {
      steps.push({ kind: "UpdatePin", pin, from: current.harnessVersion });
    }
  }
  const wanted = new Set(desired.map((pin) => pin.harness));
  for (const pin of live.filter((each) => each.pinned && !wanted.has(each.harness))) {
    steps.push({ kind: "DeletePin", harness: pin.harness });
  }
};

const sameLabels = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index]);

const planHosts = (desired: ConfigHost[], live: Host[], steps: Step[], problems: string[]): void => {
  const enrolled = live.filter((host) => host.state !== "Revoked");
  const byId = new Map(enrolled.map((host) => [host.hostId, host]));
  for (const host of desired) {
    const current = byId.get(host.hostId);
    if (current === undefined) {
      problems.push(
        `host ${host.hostId} is not enrolled to this tenant; list the hosts and use one of the hostIds it shows`,
      );
      continue;
    }
    if (!sameLabels(current.labels, host.labels)) steps.push({ kind: "LabelHost", host });
  }
  const wanted = new Set(desired.map((host) => host.hostId));
  for (const host of enrolled.filter((each) => !wanted.has(each.hostId) && each.labels.length > 0)) {
    steps.push({ kind: "LabelHost", host: { hostId: host.hostId, labels: [] } });
  }
};

export interface Desired {
  config: TenantConfig;
  files: Map<string, SentFile>;
  expiryValues: PlanRequest["expiryValues"];
  secretEnvs: Set<string>;
}

export type Planned = { ok: true; steps: Step[] } | { ok: false; problems: string[] };

export const planOf = (desired: Desired, live: Live): Planned => {
  const { config } = desired;
  const problems: string[] = [];
  const rename = "give each one its own name";
  checkUnique(
    problems,
    "the persona",
    config.personas.map((persona) => persona.name),
    rename,
  );
  checkUnique(
    problems,
    "the secret set",
    config.secretSets.map((set) => set.name),
    rename,
  );
  for (const secretSet of config.secretSets) {
    checkUnique(
      problems,
      `in secret set ${JSON.stringify(secretSet.name)} the member`,
      secretSet.secrets.map(memberName),
      "list each member once",
    );
    checkUnique(
      problems,
      `in secret set ${JSON.stringify(secretSet.name)} the credential for provider`,
      secretSet.secrets.flatMap((secret) => (secret.kind === "Variable" ? [] : [secret.provider])),
      "keep one API key or subscription token per provider",
    );
  }
  for (const persona of config.personas) {
    checkUnique(
      problems,
      `in persona ${JSON.stringify(persona.name)} the file`,
      persona.files.map((file) => file.path),
      "list each path once",
    );
  }
  checkUnique(
    problems,
    "the pin of harness",
    config.harnessPins.map((pin) => pin.harness),
    "pin each harness once",
  );
  checkUnique(
    problems,
    "the host",
    config.hosts.map((host) => host.hostId),
    "list each host once",
  );
  const fileSets = new Set(config.secretSets.map((set) => set.name));
  for (const persona of config.personas.filter((each) => !fileSets.has(each.secretSetName))) {
    problems.push(
      `persona ${JSON.stringify(persona.name)} names secret set ${JSON.stringify(persona.secretSetName)}, which the config does not hold; add it to secretSets or name one that is there`,
    );
  }
  const expiries = new Map(desired.expiryValues.map((each) => [each.env, each.expiresAt]));
  const sets = resolveSets(config, expiries, problems);
  const bundles = readBundles(config, desired.files, problems);
  const steps: Step[] = [];
  planSecretSets(sets, live.secretSets, desired.secretEnvs, steps, problems);
  planPersonas(config.personas, bundles, live, steps, problems);
  planPersonaDeletes(config.personas, live, steps, problems);
  planSecretSetDeletes(sets, live.secretSets, steps);
  planPins(config.harnessPins, live.pins, steps);
  planHosts(config.hosts, live.hosts, steps, problems);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, steps };
};

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

const secretValuesOf = (secretSet: ResolvedSet, values: Map<string, string>): unknown[] =>
  secretSet.secrets.map(({ secret, expiresAt }) => {
    const value = values.get(secret.valueFrom.env) ?? "";
    if (secret.kind === "Variable") return { kind: "Variable", name: secret.name, value };
    if (secret.kind === "ApiKey") return { kind: "ApiKey", name: secret.name, provider: secret.provider, value };
    return { kind: "SubscriptionToken", name: secret.name, provider: secret.provider, expiresAt, value };
  });

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

const personaBody = (persona: ConfigPersona, files: PlannedFile[], setIds: Map<string, string>) => ({
  name: persona.name,
  secretSetId: setIds.get(persona.secretSetName),
  files: fileWrites(files),
});

const send = (step: Step, call: Call, setIds: Map<string, string>, values: Map<string, string>): Promise<Response> => {
  switch (step.kind) {
    case "CreatePersona":
      return call("POST", "/v1/personas", {
        ...personaBody(step.persona, step.files, setIds),
        harness: step.persona.harness,
      });
    case "UpdatePersona":
      return call(
        "PUT",
        `/v1/personas/${encodeURIComponent(step.personaId)}`,
        personaBody(step.persona, step.files, setIds),
      );
    case "DeletePersona":
      return call("DELETE", `/v1/personas/${encodeURIComponent(step.personaId)}`, null);
    case "CreateSecretSet":
      return call("POST", "/v1/secret-sets", {
        name: step.secretSet.name,
        secrets: secretValuesOf(step.secretSet, values),
      });
    case "UpdateSecretSet":
    case "RewriteSecretSet":
      return call("PUT", `/v1/secret-sets/${encodeURIComponent(step.secretSetId)}`, {
        name: step.secretSet.name,
        secrets: secretValuesOf(step.secretSet, values),
      });
    case "DeleteSecretSet":
      return call("DELETE", `/v1/secret-sets/${encodeURIComponent(step.secretSetId)}`, null);
    case "CreatePin":
    case "UpdatePin":
      return call("PUT", "/v1/harnesses/pins", step.pin);
    case "DeletePin":
      return call("DELETE", `/v1/harnesses/pins/${encodeURIComponent(step.harness)}`, null);
    case "LabelHost":
      return call("PUT", `/v1/hosts/${encodeURIComponent(step.host.hostId)}/labels`, { labels: step.host.labels });
  }
};

const read = async <T>(call: Call, path: string, schema: z.ZodType<T>): Promise<Outcome<T>> => {
  const answer = await call("GET", path, null);
  if (!answer.ok) return { ok: false, response: answer };
  return { ok: true, value: schema.parse(await answer.json()) };
};

const readLive = async (call: Call): Promise<Outcome<Live>> => {
  const personas = await read(call, "/v1/personas", PersonaSchema.array());
  if (!personas.ok) return personas;
  const secretSets = await read(call, "/v1/secret-sets", SecretSetSchema.array());
  if (!secretSets.ok) return secretSets;
  const pins = await read(call, "/v1/harnesses/pins", EffectiveHarnessVersionSchema.array());
  if (!pins.ok) return pins;
  const hosts = await read(call, "/v1/hosts", HostSchema.array());
  if (!hosts.ok) return hosts;
  const sessions = await read(call, "/v1/sessions", SessionSchema.array());
  if (!sessions.ok) return sessions;
  return {
    ok: true,
    value: {
      personas: personas.value,
      secretSets: secretSets.value,
      pins: pins.value,
      hosts: hosts.value,
      sessions: sessions.value,
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

export const planConfig = async (body: PlanRequest, call: Call): Promise<Response> => {
  const live = await readLive(call);
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

export const applyConfig = async (body: ApplyRequest, call: Call): Promise<Response> => {
  const problems: string[] = [];
  const files = await writtenFiles(body.files, problems);
  if (problems.length > 0) return stopped(problems);
  const live = await readLive(call);
  if (!live.ok) return live.response;
  const values = new Map(body.secretValues.map((each) => [each.env, each.value]));
  const planned = planOf(
    { config: body.config, files, expiryValues: body.expiryValues, secretEnvs: new Set(values.keys()) },
    live.value,
  );
  if (!planned.ok) return stopped(planned.problems);
  const missing = missingValues(planned.steps, values);
  if (missing.length > 0) return stopped(missing);
  const setIds = new Map(live.value.secretSets.map((set) => [set.name, set.secretSetId]));
  const applied: ConfigChange[] = [];
  for (const step of planned.steps) {
    const change = changeOf(step);
    const answer = await send(step, call, setIds, values);
    if (!answer.ok) return refusedAt(answer, change, applied);
    if (step.kind === "CreateSecretSet") {
      const created = SecretSetSchema.parse(await answer.json());
      setIds.set(created.name, created.secretSetId);
    }
    applied.push(change);
  }
  return json(ConfigPlanSchema.parse({ changes: applied }));
};
