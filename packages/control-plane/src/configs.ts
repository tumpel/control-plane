import {
  BoxDiskLimit,
  BoxMemoryLimit,
  type ConfigChangeSchema,
  type ConfigSecretSetSchema,
  type EffectiveHarnessVersionSchema,
  type HarnessPinCreateSchema,
  PersonaFileLimit,
  type PersonaWriteSchema,
  type SecretSetCreateSchema,
  type SecretSetSchema,
  type SecretValueSchema,
  type SessionSchema,
  type TenantConfigPlanRequestSchema,
  type TriggerSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import type { GitHubUser } from "./github.ts";
import type { HostRecord } from "./host-record.ts";
import { problem } from "./http.ts";
import type { StoredPersona } from "./persona-files.ts";
import { conditionRows } from "./trigger-match.ts";

export type PlanRequest = z.infer<typeof TenantConfigPlanRequestSchema>;
export type TenantConfig = PlanRequest["config"];
export type ConfigPersona = TenantConfig["personas"][number];
type ConfigSecretSet = z.infer<typeof ConfigSecretSetSchema>;
type ConfigSecret = ConfigSecretSet["secrets"][number];
type ConfigHost = TenantConfig["hosts"][number];
type ConfigTrigger = NonNullable<TenantConfig["triggers"]>[number];
type Trigger = z.infer<typeof TriggerSchema>;
export type HarnessPinCreate = TenantConfig["harnessPins"][number];
type ConfigChange = z.infer<typeof ConfigChangeSchema>;
type SecretSet = z.infer<typeof SecretSetSchema>;
type SecretKey = SecretSet["keys"][number];
export type SecretMember = z.infer<typeof SecretValueSchema>;
export type Member = SecretKey | SecretMember;
type Pin = z.infer<typeof EffectiveHarnessVersionSchema>;
type Session = z.infer<typeof SessionSchema>;
type SecretSetWrite = z.infer<typeof SecretSetCreateSchema>;
type HarnessPinWrite = z.infer<typeof HarnessPinCreateSchema>;
type PersonaWrite = z.infer<typeof PersonaWriteSchema>;

export type ConfigWrite =
  | { kind: "CreateSecretSet"; secretSetId: string; secretSet: SecretSetWrite; githubUser: GitHubUser | null }
  | { kind: "RewriteSecretSet"; secretSetId: string; secretSet: SecretSetWrite; githubUser: GitHubUser | null }
  | { kind: "DeleteSecretSet"; secretSetId: string }
  | { kind: "CreatePersona"; persona: PersonaWrite }
  | { kind: "UpdatePersona"; personaId: string; persona: Omit<PersonaWrite, "harness"> }
  | { kind: "DeletePersona"; personaId: string }
  | { kind: "Pin"; pin: HarnessPinWrite }
  | { kind: "Unpin"; harness: string }
  | { kind: "CreateTrigger"; trigger: ConfigTrigger; principalId: string }
  | { kind: "UpdateTrigger"; triggerId: string; trigger: ConfigTrigger; principalId: string }
  | { kind: "DeleteTrigger"; triggerId: string };

export interface Live {
  personas: StoredPersona[];
  connectors: { connectorId: string; name: string }[];
  secretSets: SecretSet[];
  pins: Pin[];
  hosts: HostRecord[];
  sessions: Session[];
  triggers: Trigger[];
}

export interface LocalFile {
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

export interface PlannedFile {
  file: LocalFile;
  held: boolean;
}

type ResolvedSecret = { secret: ConfigSecret; expiresAt: string | null };

export interface ResolvedSet {
  name: string;
  secrets: ResolvedSecret[];
}

export type Step =
  | { kind: "CreatePersona"; persona: ConfigPersona; files: PlannedFile[] }
  | {
      kind: "UpdatePersona";
      personaId: string;
      persona: ConfigPersona;
      files: PlannedFile[];
      removed: string[];
    }
  | { kind: "DeletePersona"; personaId: string; name: string }
  | { kind: "CreateSecretSet"; secretSet: ResolvedSet }
  | { kind: "UpdateSecretSet"; secretSetId: string; secretSet: ResolvedSet }
  | { kind: "RewriteSecretSet"; secretSetId: string; secretSet: ResolvedSet }
  | { kind: "DeleteSecretSet"; secretSetId: string; name: string }
  | { kind: "CreatePin"; pin: HarnessPinCreate }
  | { kind: "UpdatePin"; pin: HarnessPinCreate; from: string }
  | { kind: "DeletePin"; harness: string }
  | { kind: "LabelHost"; host: ConfigHost }
  | { kind: "CreateTrigger"; trigger: ConfigTrigger }
  | { kind: "UpdateTrigger"; triggerId: string; trigger: ConfigTrigger }
  | { kind: "DeleteTrigger"; triggerId: string; name: string };

export const TRIGGER_STEPS: readonly Step["kind"][] = ["CreateTrigger", "UpdateTrigger", "DeleteTrigger"];

export const stopped = (problems: string[]): Response =>
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

export const changeOf = (step: Step): ConfigChange => {
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
    case "CreateTrigger":
      return {
        action: "Create",
        resource: "Trigger",
        name: step.trigger.name,
        description: `create trigger ${step.trigger.name} on ${step.trigger.source.kind} ${step.trigger.source.event} starting persona ${step.trigger.personaName}`,
      };
    case "UpdateTrigger":
      return {
        action: "Update",
        resource: "Trigger",
        name: step.trigger.name,
        description: `update trigger ${step.trigger.name} (${step.triggerId}) on ${step.trigger.source.kind} ${step.trigger.source.event} starting persona ${step.trigger.personaName}`,
      };
    case "DeleteTrigger":
      return {
        action: "Delete",
        resource: "Trigger",
        name: step.name,
        description: `delete trigger ${step.name} (${step.triggerId})`,
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

const planSecretSets = (desired: ResolvedSet[], live: SecretSet[], rewrite: boolean, steps: Step[]): void => {
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
    if (!same) steps.push({ kind: "UpdateSecretSet", secretSetId: current.secretSetId, secretSet });
    else if (rewrite) steps.push({ kind: "RewriteSecretSet", secretSetId: current.secretSetId, secretSet });
  }
};

const planPersonas = (
  desired: ConfigPersona[],
  bundles: Map<string, LocalFile[]>,
  live: Live,
  steps: Step[],
  problems: string[],
  turnTotalBudgetSeconds: number,
): void => {
  const byName = new Map(live.personas.map((persona) => [persona.name, persona]));
  const setIds = new Map(live.secretSets.map((set) => [set.name, set.secretSetId]));
  const connectorIds = new Map(live.connectors.map((connector) => [connector.name, connector.connectorId]));
  for (const persona of desired) {
    const unknown = persona.connectorNames.filter((name) => !connectorIds.has(name));
    if (unknown.length > 0) {
      problems.push(
        `persona ${JSON.stringify(persona.name)} names the connector ${unknown.map((name) => JSON.stringify(name)).join(", ")}, which your tenant does not have; create and connect it first, or drop it from connectorNames`,
      );
      continue;
    }
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
    const tumpelMcp = persona.tumpelMcp ?? false;
    const unchanged =
      setIds.get(persona.secretSetName) === current.secretSetId &&
      persona.connectorNames.map((name) => connectorIds.get(name)).join() === current.connectorIds.join() &&
      (persona.boxMemoryMib ?? BoxMemoryLimit.DefaultMib) === current.boxMemoryMib &&
      (persona.boxDiskMib ?? BoxDiskLimit.DefaultMib) === current.boxDiskMib &&
      (persona.turnTotalBudgetSeconds ?? turnTotalBudgetSeconds) === current.turnTotalBudgetSeconds &&
      (persona.boxRetention ?? "Auto") === current.boxRetention &&
      tumpelMcp === current.tumpelMcp &&
      removed.length === 0 &&
      files.every((file) => file.held);
    if (!unchanged) {
      steps.push({
        kind: "UpdatePersona",
        personaId: current.personaId,
        persona,
        files,
        removed,
      });
    }
  }
};

const planPersonaDeletes = (desired: ConfigPersona[], live: Live, steps: Step[], problems: string[]): void => {
  const wanted = new Set(desired.map((persona) => persona.name));
  for (const persona of live.personas.filter((each) => !wanted.has(each.name))) {
    const held = live.sessions
      .filter((session) => session.personaId === persona.personaId && !["Failed", "Archived"].includes(session.state))
      .map((session) => session.sessionId);
    if (held.length > 0) {
      problems.push(
        `delete persona ${persona.name} (${persona.personaId}) will be refused: it is still used by session ${held.join(", ")}, which is neither Failed nor Archived; archive those sessions, or keep the persona in the config`,
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

const planHosts = (desired: ConfigHost[], live: HostRecord[], steps: Step[], problems: string[]): void => {
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

const triggerShape = (trigger: ConfigTrigger): string =>
  JSON.stringify([
    trigger.source.kind,
    trigger.source.event,
    trigger.personaName,
    trigger.model,
    trigger.prompt,
    conditionRows(trigger.source.conditions).sort(
      (left, right) => left.position - right.position || left.value.localeCompare(right.value),
    ),
  ]);

const planTriggers = (config: TenantConfig, live: Live, steps: Step[], problems: string[]): void => {
  if (config.triggers === undefined) return;
  const personas = new Set(config.personas.map((persona) => persona.name));
  const personaNames = new Map(live.personas.map((persona) => [persona.personaId, persona.name]));
  const byName = new Map(live.triggers.map((trigger) => [trigger.name, trigger]));
  for (const trigger of config.triggers) {
    if (!personas.has(trigger.personaName)) {
      problems.push(
        `trigger ${JSON.stringify(trigger.name)} names persona ${JSON.stringify(trigger.personaName)}, which the config does not hold; add it to personas or name one that is there`,
      );
      continue;
    }
    const current = byName.get(trigger.name);
    if (current === undefined) {
      steps.push({ kind: "CreateTrigger", trigger });
      continue;
    }
    const held = { ...current, personaName: personaNames.get(current.personaId) ?? "" };
    if (triggerShape(held) !== triggerShape(trigger)) {
      steps.push({ kind: "UpdateTrigger", triggerId: current.triggerId, trigger });
    }
  }
  const wanted = new Set(config.triggers.map((trigger) => trigger.name));
  for (const trigger of live.triggers.filter((each) => !wanted.has(each.name))) {
    steps.push({ kind: "DeleteTrigger", triggerId: trigger.triggerId, name: trigger.name });
  }
};

export interface Desired {
  config: TenantConfig;
  files: Map<string, SentFile>;
  expiryValues: PlanRequest["expiryValues"];
  secretEnvs: Set<string>;
}

export type Planned = { ok: true; steps: Step[] } | { ok: false; problems: string[] };

export const planOf = (desired: Desired, live: Live, turnTotalBudgetSeconds: number): Planned => {
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
    "the trigger",
    (config.triggers ?? []).map((trigger) => trigger.name),
    rename,
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
  const envs = [...new Set(config.secretSets.flatMap((set) => set.secrets.map((secret) => secret.valueFrom.env)))];
  const rewrite = desired.secretEnvs.size > 0;
  const uncovered = rewrite ? envs.filter((env) => !desired.secretEnvs.has(env)) : [];
  if (uncovered.length > 0) {
    problems.push(
      `secretValues holds no ${uncovered.join(", ")}; send a value for every variable the secret sets in the file name, or none to keep the stored values of every secret set the file keeps`,
    );
  }
  const expiries = new Map(desired.expiryValues.map((each) => [each.env, each.expiresAt]));
  const sets = resolveSets(config, expiries, problems);
  const bundles = readBundles(config, desired.files, problems);
  const steps: Step[] = [];
  planSecretSets(sets, live.secretSets, rewrite, steps);
  planPersonas(config.personas, bundles, live, steps, problems, turnTotalBudgetSeconds);
  planPersonaDeletes(config.personas, live, steps, problems);
  planSecretSetDeletes(sets, live.secretSets, steps);
  planPins(config.harnessPins, live.pins, steps);
  planHosts(config.hosts, live.hosts, steps, problems);
  planTriggers(config, live, steps, problems);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, steps };
};
