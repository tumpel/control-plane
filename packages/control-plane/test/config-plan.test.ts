import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  EffectiveHarnessVersionSchema,
  HostRecordSchema,
  PersonaFileLimit,
  SecretSetSchema,
  SessionSchema,
  TenantConfigSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { type Desired, type Live, type Planned, planOf, type SentFile, type Step } from "../src/configs.ts";
import { StoredPersonaSchema } from "../src/persona-files.ts";

type TenantConfig = z.infer<typeof TenantConfigSchema>;
type ConfigPersona = TenantConfig["personas"][number];
type ConfigSecretSet = TenantConfig["secretSets"][number];

const persona = (
  name: string,
  harness: string,
  secretSetName: string,
  files: unknown[] = [],
  connectorNames: string[] = [],
): ConfigPersona =>
  TenantConfigSchema.shape.personas.element.parse({ name, harness, secretSetName, files, connectorNames });

const member = (key: string): Record<string, string> =>
  key === "ANTHROPIC_API_KEY" ? { kind: "ApiKey", name: key, provider: "Anthropic" } : { kind: "Variable", name: key };

const secretSet = (name: string, keys: string[]): ConfigSecretSet =>
  TenantConfigSchema.shape.secretSets.element.parse({
    name,
    secrets: keys.map((key) => ({ ...member(key), valueFrom: { env: key } })),
  });

const config = (parts: Partial<Omit<TenantConfig, "$schema">> = {}): TenantConfig =>
  TenantConfigSchema.parse({
    $schema: "https://example.test/TenantConfig.json",
    personas: [persona("Default", "ClaudeCode", "prod")],
    secretSets: [secretSet("prod", ["ANTHROPIC_API_KEY"])],
    harnessPins: [{ harness: "ClaudeCode", harnessVersion: "2.0.0" }],
    hosts: [{ hostId: "h1", labels: ["gpu"] }],
    ...parts,
  });

const livePersona = (personaId: string, name: string, harness: string, secretSetId: string, files: unknown[] = []) =>
  StoredPersonaSchema.parse({
    personaId,
    tenantId: "t1",
    name,
    harness,
    secretSetId,
    connectorIds: [],
    boxMemoryMib: 2048,
    boxDiskMib: 32768,
    boxRetention: "Auto",
    tumpelMcp: false,
    files,
    createdAt: 1,
    updatedAt: 1,
  });

const liveSecretSet = (secretSetId: string, name: string, keys: string[]) =>
  SecretSetSchema.parse({
    secretSetId,
    tenantId: "t1",
    name,
    keys: keys.map((key) => ({ ...member(key), updatedAt: 1 })),
    createdAt: 1,
    updatedAt: 1,
  });

const liveHost = (hostId: string, state: string, labels: string[]) =>
  HostRecordSchema.parse({
    hostId,
    tenantId: "t1",
    name: hostId,
    state,
    health: "Healthy",
    reportedHealth: "Healthy",
    architecture: "Amd64",
    cpuCount: 4,
    memoryBytes: 1024,
    publicKey: "key",
    supervisorVersion: "0.1.0",
    labels,
    supervisorUpdateStep: { state: "NotReported" },
    supervisorUpdateFailure: { state: "NotReported" },
    channelProtocol: { state: "NotReported" },
    guestProtocol: { state: "NotReported" },
    createdAt: 1,
    updatedAt: 1,
  });

const liveSession = (sessionId: string, personaId: string, state: string) =>
  SessionSchema.parse({
    sessionId,
    tenantId: "t1",
    principalId: "u1",
    hostId: "h1",
    boxId: "b1",
    personaId,
    boxRetention: "Auto",
    startedBy: { kind: "Person", principalId: "u1" },
    tags: [],
    repository: "https://github.com/acme/app.git",
    origin: { kind: "Prompt" },
    harness: "ClaudeCode",
    harnessVersion: "2.0.0",
    model: "claude-test",
    state,
    lastTurnId: "turn1",
    lastTurnState: "Completed",
    lastTurnAt: "2026-11-15T12:00:00+01:00",
    lastTurn: {
      turnId: "turn1",
      tenantId: "t1",
      sessionId,
      boxId: "b1",
      prompt: "work",
      state: "Completed",
      lineCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  });

const steady = (parts: Partial<Live> = {}): Live => ({
  personas: [livePersona("p1", "Default", "ClaudeCode", "s1")],
  connectors: [],
  secretSets: [liveSecretSet("s1", "prod", ["ANTHROPIC_API_KEY"])],
  pins: EffectiveHarnessVersionSchema.array().parse([{ harness: "ClaudeCode", harnessVersion: "2.0.0", pinned: true }]),
  hosts: [liveHost("h1", "Online", ["gpu"])],
  sessions: [],
  triggers: [],
  ...parts,
});

const desired = (
  tenantConfig: TenantConfig,
  files: Map<string, SentFile> = new Map(),
  secretEnvs: string[] = [],
): Desired => ({ config: tenantConfig, files, expiryValues: [], secretEnvs: new Set(secretEnvs) });

const resolved = (set: ConfigSecretSet) => ({
  name: set.name,
  secrets: set.secrets.map((secret) => ({ secret, expiresAt: null })),
});

const sent = (content: string): SentFile => ({
  digest: createHash("sha256").update(content).digest("hex"),
  sizeBytes: Buffer.byteLength(content),
  content: Buffer.from(content).toString("base64"),
});

const heldFile = (path: string, content: string) => ({
  path,
  digest: sent(content).digest,
  sizeBytes: Buffer.byteLength(content),
  createdAt: 1,
  updatedAt: 1,
});

const steps = (...expected: Step[]): Planned => ({ ok: true, steps: expected });
const problems = (...expected: string[]): Planned => ({ ok: false, problems: expected });

const moved = config({
  personas: [persona("Default", "ClaudeCode", "ci")],
  secretSets: [secretSet("prod", ["ANTHROPIC_API_KEY"]), secretSet("ci", ["ANTHROPIC_API_KEY"])],
});

const differs = config({
  personas: [persona("Default", "ClaudeCode", "prod"), persona("Reviewer", "ClaudeCode", "ci")],
  secretSets: [secretSet("prod", ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]), secretSet("ci", ["CI_KEY"])],
  harnessPins: [
    { harness: "ClaudeCode", harnessVersion: "2.1.0" },
    { harness: "Codex", harnessVersion: "0.9.0" },
  ],
  hosts: [],
});

const subscription = config({
  secretSets: [
    TenantConfigSchema.shape.secretSets.element.parse({
      name: "prod",
      secrets: [
        {
          kind: "SubscriptionToken",
          name: "ANTHROPIC_API_KEY",
          provider: "Anthropic",
          expiresAt: "2026-12-01T00:00:00+01:00",
          valueFrom: { env: "ANTHROPIC_API_KEY" },
        },
      ],
    }),
  ],
});

const twoMembers = config({ secretSets: [secretSet("prod", ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"])] });
const twoKeys = steady({ secretSets: [liveSecretSet("s1", "prod", ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"])] });

const withFiles = config({
  personas: [
    persona("Default", "ClaudeCode", "prod", [
      { path: ".claude/settings.json", from: "settings.json" },
      { path: ".claude/CLAUDE.md", from: "CLAUDE.md" },
    ]),
  ],
});

const big = "a".repeat(PersonaFileLimit.PersonaBytes + 1);

const cases: { name: string; desired: Desired; live: Live; planned: Planned }[] = [
  {
    name: "a config that matches the tenant plans nothing",
    desired: desired(config()),
    live: steady(),
    planned: steps(),
  },
  {
    name: "a config that differs plans creates, updates and deletes in dependency order",
    desired: desired(differs),
    live: steady({
      personas: [livePersona("p1", "Default", "ClaudeCode", "s2"), livePersona("p2", "Old", "ClaudeCode", "s2")],
      secretSets: [liveSecretSet("s1", "prod", ["ANTHROPIC_API_KEY"]), liveSecretSet("s2", "stale", ["X"])],
      pins: EffectiveHarnessVersionSchema.array().parse([
        { harness: "ClaudeCode", harnessVersion: "2.0.0", pinned: true },
        { harness: "PiDev", harnessVersion: "1.0.0", pinned: true },
      ]),
      hosts: [liveHost("h1", "Online", ["gpu"]), liveHost("h2", "Offline", []), liveHost("h3", "Revoked", ["old"])],
    }),
    planned: steps(
      {
        kind: "UpdateSecretSet",
        secretSetId: "s1",
        secretSet: resolved(secretSet("prod", ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])),
      },
      { kind: "CreateSecretSet", secretSet: resolved(secretSet("ci", ["CI_KEY"])) },
      {
        kind: "UpdatePersona",
        personaId: "p1",
        persona: persona("Default", "ClaudeCode", "prod"),
        files: [],
        removed: [],
      },
      { kind: "CreatePersona", persona: persona("Reviewer", "ClaudeCode", "ci"), files: [] },
      { kind: "DeletePersona", personaId: "p2", name: "Old" },
      { kind: "DeleteSecretSet", secretSetId: "s2", name: "stale" },
      { kind: "UpdatePin", pin: { harness: "ClaudeCode", harnessVersion: "2.1.0" }, from: "2.0.0" },
      { kind: "CreatePin", pin: { harness: "Codex", harnessVersion: "0.9.0" } },
      { kind: "DeletePin", harness: "PiDev" },
      { kind: "LabelHost", host: { hostId: "h1", labels: [] } },
    ),
  },
  {
    name: "a harness change of a live persona is refused",
    desired: desired(config({ personas: [persona("Default", "PiDev", "prod")] })),
    live: steady(),
    planned: problems(
      `persona "Default" runs ClaudeCode, and a persona's harness is fixed when it is created; give the PiDev persona a new name, or delete "Default" first`,
    ),
  },
  {
    name: "a persona left out with a session that is neither Failed nor Archived stops the plan",
    desired: desired(config()),
    live: steady({
      personas: [livePersona("p1", "Default", "ClaudeCode", "s1"), livePersona("p2", "Old", "ClaudeCode", "s1")],
      sessions: [
        liveSession("a1", "p2", "Archived"),
        liveSession("i1", "p2", "Idle"),
        liveSession("f1", "p2", "Failed"),
        liveSession("o1", "p1", "Running"),
      ],
    }),
    planned: problems(
      "delete persona Old (p2) will be refused: it is still used by session i1, which is neither Failed nor Archived; archive those sessions, or keep the persona in the config",
    ),
  },
  {
    name: "a host that is not enrolled and a repeated name stop the plan",
    desired: desired(
      config({
        personas: [persona("Default", "ClaudeCode", "prod"), persona("Default", "ClaudeCode", "prod")],
        hosts: [{ hostId: "h9", labels: [] }],
      }),
    ),
    live: steady(),
    planned: problems(
      `the persona "Default" appears more than once; give each one its own name`,
      "host h9 is not enrolled to this tenant; list the hosts and use one of the hostIds it shows",
    ),
  },
  {
    name: "a persona naming a secret set outside the config stops the plan",
    desired: desired(config({ personas: [persona("Default", "ClaudeCode", "staging")] })),
    live: steady(),
    planned: problems(
      `persona "Default" names secret set "staging", which the config does not hold; add it to secretSets or name one that is there`,
    ),
  },
  {
    name: "a persona moved to another set creates the set and updates the persona",
    desired: desired(moved),
    live: steady(),
    planned: steps(
      { kind: "CreateSecretSet", secretSet: resolved(secretSet("ci", ["ANTHROPIC_API_KEY"])) },
      {
        kind: "UpdatePersona",
        personaId: "p1",
        persona: persona("Default", "ClaudeCode", "ci"),
        files: [],
        removed: [],
      },
    ),
  },
  {
    name: "a member whose kind or expiry changes updates its set",
    desired: desired(subscription),
    live: steady(),
    planned: steps({
      kind: "UpdateSecretSet",
      secretSetId: "s1",
      secretSet: {
        name: "prod",
        secrets: (subscription.secretSets[0]?.secrets ?? []).map((secret) => ({
          secret,
          expiresAt: "2026-12-01T00:00:00+01:00",
        })),
      },
    }),
  },
  {
    name: "a kept set is rewritten when every value it names is sent",
    desired: desired(twoMembers, new Map(), ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]),
    live: twoKeys,
    planned: steps({
      kind: "RewriteSecretSet",
      secretSetId: "s1",
      secretSet: resolved(secretSet("prod", ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"])),
    }),
  },
  {
    name: "values that leave out any variable the file names stop the plan",
    desired: desired(twoMembers, new Map(), ["ANTHROPIC_API_KEY"]),
    live: twoKeys,
    planned: problems(
      "secretValues holds no GITHUB_TOKEN; send a value for every variable the secret sets in the file name, or none to keep the stored values of every secret set the file keeps",
    ),
  },
  {
    name: "persona files over the persona cap stop the plan",
    desired: desired(
      config({
        personas: [persona("Default", "ClaudeCode", "prod", [{ path: ".claude/CLAUDE.md", from: "CLAUDE.md" }])],
      }),
      new Map([["CLAUDE.md", sent(big)]]),
    ),
    live: steady(),
    planned: problems(
      `persona "Default" holds ${big.length} bytes of files, over the ${PersonaFileLimit.PersonaBytes}-byte cap on a persona; trim the files or split them across personas`,
    ),
  },
  {
    name: "persona files that match the held digests plan nothing",
    desired: desired(
      withFiles,
      new Map([
        ["settings.json", sent("{}")],
        ["CLAUDE.md", sent("be brief")],
      ]),
    ),
    live: steady({
      personas: [
        livePersona("p1", "Default", "ClaudeCode", "s1", [
          heldFile(".claude/settings.json", "{}"),
          heldFile(".claude/CLAUDE.md", "be brief"),
        ]),
      ],
    }),
    planned: steps(),
  },
  {
    name: "an edited persona file is written by its digest and a dropped one deleted",
    desired: desired(
      withFiles,
      new Map([
        ["settings.json", sent("{}")],
        ["CLAUDE.md", sent("be thorough")],
      ]),
    ),
    live: steady({
      personas: [
        livePersona("p1", "Default", "ClaudeCode", "s1", [
          heldFile(".claude/settings.json", "{}"),
          heldFile(".claude/CLAUDE.md", "be brief"),
          heldFile(".claude.json", "{}"),
        ]),
      ],
    }),
    planned: steps({
      kind: "UpdatePersona",
      personaId: "p1",
      persona: withFiles.personas[0] ?? persona("Default", "ClaudeCode", "prod"),
      files: [
        { file: { path: ".claude/settings.json", ...sent("{}") }, held: true },
        { file: { path: ".claude/CLAUDE.md", ...sent("be thorough") }, held: false },
      ],
      removed: [".claude.json"],
    }),
  },
];

for (const each of cases) {
  test(each.name, () => {
    assert.deepEqual(planOf(each.desired, each.live), each.planned);
  });
}

test("a persona naming a connector the tenant lacks fails the plan, and a changed connector list updates it", () => {
  const live = steady({ connectors: [{ connectorId: "c1", name: "Recall" }] });
  assert.deepEqual(
    planOf(desired(config({ personas: [persona("Default", "ClaudeCode", "prod", [], ["Linear"])] })), live),
    problems(
      'persona "Default" names the connector "Linear", which your tenant does not have; create and connect it first, or drop it from connectorNames',
    ),
  );
  const planned = planOf(
    desired(config({ personas: [persona("Default", "ClaudeCode", "prod", [], ["Recall"])] })),
    live,
  );
  assert.equal(planned.ok && planned.steps.some((step) => step.kind === "UpdatePersona"), true);
});

test("a persona's tumpel MCP setting follows the config and defaults to false", () => {
  const live = steady({ personas: [{ ...livePersona("p1", "Default", "ClaudeCode", "s1"), tumpelMcp: true }] });
  const kept = planOf(
    desired(
      config({
        personas: [{ ...persona("Default", "ClaudeCode", "ci"), tumpelMcp: true }],
        secretSets: moved.secretSets,
      }),
    ),
    live,
  );
  assert.equal(
    kept.ok && kept.steps.some((step) => step.kind === "UpdatePersona" && step.persona.tumpelMcp === true),
    true,
  );
  const disabled = planOf(desired(config()), live);
  assert.equal(disabled.ok && disabled.steps.some((step) => step.kind === "UpdatePersona"), true);
});

test("triggers plan by name: create, keep when only the condition rows reorder, update, delete, and stay when left out", () => {
  const review = {
    name: "review",
    source: {
      kind: "GitHub" as const,
      event: "status" as const,
      conditions: [
        { field: "state", values: ["pending", "error"] },
        { field: "context", values: ["agent-review"] },
      ],
    },
    personaName: "Default",
    model: "claude-test",
    prompt: "Review {{sha}}",
  };
  const held = {
    triggerId: "g1",
    tenantId: "t1",
    name: "review",
    source: {
      kind: "GitHub" as const,
      event: "status" as const,
      conditions: [
        { field: "state", values: ["error", "pending"] },
        { field: "context", values: ["agent-review"] },
      ],
    },
    personaId: "p1",
    model: "claude-test",
    prompt: "Review {{sha}}",
    principalId: "u1",
    createdAt: 1,
    updatedAt: 1,
  };
  assert.deepEqual(
    planOf(desired(config({ triggers: [review] })), steady()),
    steps({ kind: "CreateTrigger", trigger: review }),
  );
  assert.deepEqual(planOf(desired(config({ triggers: [review] })), steady({ triggers: [held] })), steps());
  const changed = { ...review, prompt: "Review {{sha}} again" };
  assert.deepEqual(
    planOf(desired(config({ triggers: [changed] })), steady({ triggers: [held] })),
    steps({ kind: "UpdateTrigger", triggerId: "g1", trigger: changed }),
  );
  assert.deepEqual(
    planOf(desired(config({ triggers: [] })), steady({ triggers: [held] })),
    steps({ kind: "DeleteTrigger", triggerId: "g1", name: "review" }),
  );
  assert.deepEqual(planOf(desired(config()), steady({ triggers: [held] })), steps());
  assert.deepEqual(
    planOf(desired(config({ triggers: [{ ...review, personaName: "Reviewer" }] })), steady()),
    problems(
      'trigger "review" names persona "Reviewer", which the config does not hold; add it to personas or name one that is there',
    ),
  );
});
