import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { after, before, test } from "node:test";
import {
  ConfigPlanSchema,
  EffectiveHarnessVersionSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  PersonaFileLimit,
  PersonaSchema,
  ProblemSchema,
  SecretSetSchema,
} from "@tumpel/schemas";
import { CLAUDE_CODE_VERSION } from "../../src/harness-catalog.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "../release-fixture.ts";
import { World } from "./harness/world.ts";

const EMAIL = "config@example.test";
const SECRET = "sk-ant-e2e-never-printed";
const REVIEWER_MEMORY = "Review the diff for correctness.\n";
const REVIEWER_SETTINGS = '{"permissions":{"defaultMode":"bypassPermissions"}}\n';
const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

const FIXTURE = {
  personas: [
    {
      name: "Reviewer",
      harness: "ClaudeCode",
      secretSetName: "prod",
      connectorNames: [],
      files: [
        { path: ".claude/CLAUDE.md", from: "reviewer/CLAUDE.md" },
        { path: ".claude/settings.json", from: "reviewer/settings.json" },
      ],
    },
  ],
  secretSets: [
    {
      name: "prod",
      secrets: [
        {
          kind: "ApiKey",
          name: "ANTHROPIC_API_KEY",
          provider: "Anthropic",
          valueFrom: { env: "TUMPEL_E2E_ANTHROPIC_KEY" },
        },
      ],
    },
  ],
  harnessPins: [{ harness: "ClaudeCode", harnessVersion: CLAUDE_CODE_VERSION }],
  hosts: [] as { hostId: string; labels: string[] }[],
};

let world: World;
let bearer: Record<string, string>;
let tenant: string;

const getJson = async (path: string): Promise<unknown> => {
  const response = await world.request(path, { headers: bearer });
  assert.equal(response.status, 200, path);
  return response.json();
};

const send = (method: string, path: string, body: unknown): Promise<Response> =>
  world.request(path, {
    method,
    headers: { "content-type": "application/json", ...bearer },
    body: JSON.stringify(body),
  });

const files = (local: Record<string, string>) => ({
  inline: Object.entries(local).map(([from, text]) => ({
    source: "Inline",
    from,
    content: Buffer.from(text).toString("base64"),
  })),
  digests: Object.entries(local).map(([from, text]) => ({
    from,
    digest: sha256(text),
    sizeBytes: Buffer.byteLength(text),
  })),
});

const apply = async (config: unknown, local: Record<string, string>, secret: string) => {
  const response = await world.postJson(
    "/v1/tenant-config/apply",
    {
      config,
      files: files(local).inline,
      secretValues: [{ env: "TUMPEL_E2E_ANTHROPIC_KEY", value: secret }],
      expiryValues: [],
    },
    bearer,
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.ok(!text.includes(secret));
  return ConfigPlanSchema.parse(JSON.parse(text)).changes;
};

const plan = async (config: unknown, local: Record<string, string>) => {
  const response = await world.postJson(
    "/v1/tenant-config/plan",
    {
      config,
      files: files(local).digests,
      secretValues: [],
      expiryValues: [],
    },
    bearer,
  );
  assert.equal(response.status, 200);
  return ConfigPlanSchema.parse(await response.json()).changes;
};

const enrolHost = async (): Promise<string> => {
  const minted = MintedEnrolmentTokenSchema.parse(
    await (await world.postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer)).json(),
  );
  const raw = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x ?? "";
  const enrolled = await world.postJson("/v1/hosts/enrol", {
    enrolmentToken: minted.token,
    name: "builder",
    architecture: "Amd64",
    cpuCount: 4,
    memoryBytes: 8_000_000_000,
    publicKey: Buffer.from(raw, "base64url").toString("base64"),
    supervisorVersion: "0.1.0",
  });
  assert.equal(enrolled.status, 200);
  return HostSchema.parse(await enrolled.json()).hostId;
};

const tenantRows = (): Record<string, unknown[]> => {
  const sql = world.tenantStorage(tenant).sql;
  const tables = sql
    .exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .toArray()
    .map((row) => String(row.name));
  const rows: Record<string, unknown[]> = {};
  for (const name of tables) rows[name] = sql.exec(`SELECT * FROM "${name}" ORDER BY rowid`).toArray();
  return rows;
};

before(async () => {
  world = await World.open({ vars: { R2_STUB_ORIGIN: "https://r2.example.test" } });
  ({ tenantId: tenant, bearer } = await world.signUp("Config", EMAIL));
});

after(() => world.close());

test("tumpel config apply makes the tenant match the file, and a second plan is empty", async () => {
  const hostId = await enrolHost();
  await world.releases.put("current.json", JSON.stringify(CLAUDE_CODE_AMD64_RELEASE));
  const config = { ...FIXTURE, hosts: [{ hostId, labels: ["gpu", "region-eu"] }] };
  const local = { "reviewer/CLAUDE.md": REVIEWER_MEMORY, "reviewer/settings.json": REVIEWER_SETTINGS };

  const applied = await apply(config, local, SECRET);
  assert.deepEqual(
    applied.map((change) => [change.action, change.resource]),
    [
      ["Create", "SecretSet"],
      ["Create", "Persona"],
      ["Delete", "Persona"],
      ["Delete", "SecretSet"],
      ["Create", "HarnessPin"],
      ["Update", "Host"],
    ],
  );
  assert.deepEqual(
    [applied[1]?.name, applied[2]?.name, applied[4]?.name, applied[5]?.name],
    ["Reviewer", "Default", "ClaudeCode", hostId],
  );

  assert.deepEqual(await plan(config, local), []);

  const rotated = await apply(config, local, `${SECRET}-rotated`);
  assert.deepEqual(
    rotated.map((change) => [change.action, change.resource, change.name]),
    [["Rewrite", "SecretSet", "prod"]],
  );

  const personas = PersonaSchema.array().parse(await getJson("/v1/personas"));
  assert.deepEqual(
    personas.map((persona) => [persona.name, persona.harness, persona.files.map((held) => [held.path, held.digest])]),
    [
      [
        "Reviewer",
        "ClaudeCode",
        [
          [".claude/CLAUDE.md", sha256(REVIEWER_MEMORY)],
          [".claude/settings.json", sha256(REVIEWER_SETTINGS)],
        ],
      ],
    ],
  );

  const edited = await plan(config, { ...local, "reviewer/CLAUDE.md": "Review closely.\n" });
  const described = edited.map((change) => change.description).join("\n");
  assert.match(described, /files: write \.claude\/CLAUDE\.md \(\d+ bytes, sha256 [0-9a-f]{64}\)$/m);
  assert.doesNotMatch(described, /settings\.json/);
  const sets = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.deepEqual(
    sets.map((set) => [set.name, set.keys.map((key) => [key.kind, key.name])]),
    [["prod", [["ApiKey", "ANTHROPIC_API_KEY"]]]],
  );
  assert.ok(!JSON.stringify(sets).includes(SECRET));
  const versions = EffectiveHarnessVersionSchema.array().parse(await getJson("/v1/harnesses/pins"));
  assert.deepEqual(
    versions.filter((row) => row.pinned).map((pin) => [pin.harness, pin.harnessVersion]),
    [["ClaudeCode", CLAUDE_CODE_VERSION]],
  );
  assert.deepEqual(HostSchema.parse(await getJson(`/v1/hosts/${hostId}`)).labels, ["gpu", "region-eu"]);
});

test("an apply refused at a later change writes none of the earlier ones", async () => {
  const held = await Promise.all(["/v1/personas", "/v1/secret-sets", "/v1/harnesses/pins"].map(getJson));
  const refused = await world.postJson(
    "/v1/tenant-config/apply",
    {
      config: {
        ...FIXTURE,
        personas: [{ name: "Atomic", harness: "ClaudeCode", secretSetName: "atomic", connectorNames: [], files: [] }],
        secretSets: [{ ...FIXTURE.secretSets[0], name: "atomic" }],
        harnessPins: [{ harness: "ClaudeCode", harnessVersion: "0.0.1" }],
        hosts: [],
      },
      files: [],
      secretValues: [{ env: "TUMPEL_E2E_ANTHROPIC_KEY", value: SECRET }],
      expiryValues: [],
    },
    bearer,
  );
  assert.equal(refused.status, 422);
  assert.match(ProblemSchema.parse(await refused.json()).detail, /no change was applied$/);
  const kept = await Promise.all(["/v1/personas", "/v1/secret-sets", "/v1/harnesses/pins"].map(getJson));
  assert.deepEqual(kept, held);
});

test("a write that breaks a constraint inside the apply transaction rolls back every earlier write", async () => {
  const held = tenantRows();
  const secretSetId = crypto.randomUUID();
  const persona = {
    name: "Rollback",
    harness: "ClaudeCode",
    secretSetId,
    connectorIds: [],
    boxMemoryMib: 4096,
    boxDiskMib: 32768,
    boxRetention: "Auto",
    tumpelMcp: false,
    files: [],
  };
  const { applied } = (await world.callTenant(tenant, "applyConfig", {
    tenantId: tenant,
    writes: [
      {
        kind: "CreateSecretSet",
        secretSetId,
        secretSet: {
          name: "rollback",
          secrets: [{ kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: SECRET }],
        },
        githubUser: null,
      },
      { kind: "Pin", pin: { harness: "ClaudeCode", harnessVersion: CLAUDE_CODE_VERSION } },
      { kind: "CreatePersona", persona },
      { kind: "CreatePersona", persona },
    ],
    now: Date.now(),
  })) as { applied: { kind: string } };
  assert.equal(applied.kind, "Conflict");
  assert.deepEqual(tenantRows(), held);
});

test("a taken name, a repeated member, two credentials for one provider and deleting a set in use are refused with 409 Conflict, and a persona on a set without a key its harness reads or an OpenRouter key on an Anthropic member with 422", async () => {
  const key = { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: SECRET };
  const created = await world.postJson("/v1/secret-sets", { name: "twin", secrets: [key] }, bearer);
  assert.equal(created.status, 200);
  const { secretSetId } = SecretSetSchema.parse(await created.json());
  const openRouterKey = "sk-or-v1-e2e-never-printed";
  const misfiled = await send("PUT", `/v1/secret-sets/${secretSetId}/members`, { ...key, value: openRouterKey });
  assert.equal(misfiled.status, 422);
  const mismatch = await misfiled.text();
  assert.match(ProblemSchema.parse(JSON.parse(mismatch)).detail, /Anthropic, whose keys start with sk-ant-/);
  assert.ok(!mismatch.includes(openRouterKey));
  const taken = await world.postJson("/v1/secret-sets", { name: "twin", secrets: [key] }, bearer);
  assert.equal(taken.status, 409);
  assert.equal(ProblemSchema.parse(await taken.json()).code, "Conflict");
  const repeated = await world.postJson("/v1/secret-sets", { name: "repeated", secrets: [key, key] }, bearer);
  assert.equal(repeated.status, 409);
  assert.equal(ProblemSchema.parse(await repeated.json()).title, "Repeated member");
  const token = { ...key, kind: "SubscriptionToken", name: "CLAUDE_TOKEN", expiresAt: "2026-12-01T00:00:00+01:00" };
  const doubled = await world.postJson("/v1/secret-sets", { name: "doubled", secrets: [key, token] }, bearer);
  assert.equal(doubled.status, 409);
  assert.equal(ProblemSchema.parse(await doubled.json()).title, "Two credentials for one provider");
  const sets = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(!sets.some((set) => set.name === "repeated" || set.name === "doubled"));

  const persona = { name: "Twin", harness: "ClaudeCode", secretSetId, connectorIds: [], files: [] };
  assert.equal((await world.postJson("/v1/personas", persona, bearer)).status, 200);
  const twin = await world.postJson("/v1/personas", persona, bearer);
  assert.equal(twin.status, 409);
  assert.equal(ProblemSchema.parse(await twin.json()).code, "Conflict");
  const unknown = await world.postJson(
    "/v1/personas",
    { ...persona, name: "Lost", secretSetId: "no-such-set", connectorIds: [] },
    bearer,
  );
  assert.equal(unknown.status, 422);
  const keyless = await world.postJson("/v1/personas", { ...persona, name: "Keyless", harness: "Codex" }, bearer);
  assert.equal(keyless.status, 422);
  const refusal = ProblemSchema.parse(await keyless.json());
  assert.equal(refusal.code, "NoCredential");
  assert.equal(
    refusal.detail,
    "secret set twin holds no credential Codex reads: a CredentialFile for OpenAi, or a ApiKey for OpenAi, or a ApiKey for OpenRouter",
  );
  assert.equal(refusal.fix, "Add one of those to that secret set, then repeat personas.create");

  const inUse = await world.request(`/v1/secret-sets/${secretSetId}`, { method: "DELETE", headers: bearer });
  assert.equal(inUse.status, 409);
  assert.match(ProblemSchema.parse(await inUse.json()).detail, /Twin/);
});

test("a persona file at a path its harness does not read is refused, a stored file must be in the store, and a read returns every file's bytes", async () => {
  const [set] = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(set);
  const content = Buffer.from("{}").toString("base64");
  const base = { name: "Files", harness: "ClaudeCode", secretSetId: set.secretSetId, connectorIds: [] };
  const misplaced = await world.postJson(
    "/v1/personas",
    { ...base, files: [{ source: "Inline", path: ".bashrc", content }] },
    bearer,
  );
  assert.equal(misplaced.status, 422);
  assert.match(ProblemSchema.parse(await misplaced.json()).detail, /\.bashrc.*accepts \.claude\/settings\.json/);

  const created = await world.postJson(
    "/v1/personas",
    { ...base, files: [{ source: "Inline", path: ".claude/settings.json", content }] },
    bearer,
  );
  assert.equal(created.status, 200);
  const persona = PersonaSchema.parse(await created.json());
  const [held] = persona.files;
  assert.ok(held);
  assert.equal(held.digest, sha256("{}"));
  const put = (files: unknown[]) => send("PUT", `/v1/personas/${persona.personaId}`, { ...base, files });
  const kept = await put([
    { source: "Stored", path: ".claude/CLAUDE.md", digest: held.digest, sizeBytes: held.sizeBytes },
  ]);
  assert.equal(kept.status, 200);
  assert.deepEqual(
    PersonaSchema.parse(await kept.json()).files.map((file) => [file.path, file.digest]),
    [[".claude/CLAUDE.md", held.digest]],
  );
  const missing = await put([{ source: "Stored", path: ".claude/CLAUDE.md", digest: "f".repeat(64), sizeBytes: 2 }]);
  assert.equal(missing.status, 422);
  assert.equal(ProblemSchema.parse(await missing.json()).title, "Persona file not uploaded");

  const large = Buffer.alloc(PersonaFileLimit.InlineFileBytes + 1, "l");
  const largeDigest = sha256(large);
  await world.store.put(`${tenant}/persona-files/${largeDigest}`, large);
  const both = await put([
    { source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from(REVIEWER_MEMORY).toString("base64") },
    { source: "Stored", path: ".claude/settings.json", digest: largeDigest, sizeBytes: large.byteLength },
  ]);
  assert.equal(both.status, 200);
  const [memory, settings] = PersonaSchema.parse(await getJson(`/v1/personas/${persona.personaId}`)).files;
  assert.ok(memory?.source === "Inline");
  assert.equal(memory.content, Buffer.from(REVIEWER_MEMORY).toString("base64"));
  assert.ok(settings?.source === "Stored");
  const download = new URL(settings.downloadUrl);
  assert.equal(download.searchParams.get("X-Tumpel-Method"), "GET");
  const blob = await world.store.get(decodeURIComponent(download.pathname).replace(/^\/[^/]+\//, ""));
  assert.ok(blob);
  assert.equal(sha256(Buffer.from(await blob.arrayBuffer())), settings.digest);
});

test("tumpel persona get output without its server fields creates a copy with the same files, and persona list returns every file's bytes", async () => {
  const [set] = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(set);
  const large = Buffer.alloc(PersonaFileLimit.InlineFileBytes + 1, "l");
  const largeDigest = sha256(large);
  await world.store.put(`${tenant}/persona-files/${largeDigest}`, large);
  const created = await world.postJson(
    "/v1/personas",
    {
      name: "Original",
      harness: "ClaudeCode",
      secretSetId: set.secretSetId,
      connectorIds: [],
      files: [
        { source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from(REVIEWER_MEMORY).toString("base64") },
        { source: "Stored", path: ".claude/settings.json", digest: largeDigest, sizeBytes: large.byteLength },
      ],
    },
    bearer,
  );
  assert.equal(created.status, 200);
  const { personaId } = PersonaSchema.parse(await created.json());

  const original = PersonaSchema.parse(await getJson(`/v1/personas/${personaId}`));
  const [memory] = original.files;
  assert.ok(memory?.source === "Inline");
  assert.equal(Buffer.from(memory.content, "base64").toString(), REVIEWER_MEMORY);

  const { personaId: _id, tenantId: _tenant, createdAt: _created, updatedAt: _updated, ...written } = original;
  const copy = {
    ...written,
    name: "Copy",
    files: written.files.map((file) =>
      file.source === "Inline"
        ? { source: file.source, path: file.path, content: file.content }
        : { source: file.source, path: file.path, digest: file.digest, sizeBytes: file.sizeBytes },
    ),
  };
  const copied = await world.postJson("/v1/personas", copy, bearer);
  assert.equal(copied.status, 200);
  assert.deepEqual(
    PersonaSchema.parse(await copied.json()).files.map((file) => [file.source, file.path, file.digest]),
    [
      ["Inline", ".claude/CLAUDE.md", sha256(REVIEWER_MEMORY)],
      ["Stored", ".claude/settings.json", largeDigest],
    ],
  );

  const [listedMemory] =
    PersonaSchema.array()
      .parse(await getJson("/v1/personas"))
      .find((persona) => persona.personaId === personaId)?.files ?? [];
  assert.deepEqual(listedMemory, memory);
});

test("secret-set set-member writes one member from stdin and keeps the rest, and remove-member drops one", async () => {
  const created = await world.postJson("/v1/secret-sets", { name: "piped", secrets: [] }, bearer);
  assert.equal(created.status, 200, await created.clone().text());
  const { secretSetId } = SecretSetSchema.parse(await created.json());

  const keyed = await send("PUT", `/v1/secret-sets/${secretSetId}/members`, {
    kind: "ApiKey",
    name: "ANTHROPIC_API_KEY",
    provider: "Anthropic",
    value: SECRET,
  });
  assert.equal(keyed.status, 200);
  const both = await send("PUT", `/v1/secret-sets/${secretSetId}/members`, {
    kind: "Variable",
    name: "DEPLOY_TOKEN",
    value: SECRET,
  });
  assert.equal(both.status, 200);
  const keyedText = await keyed.text();
  const bothText = await both.text();
  assert.ok(!`${keyedText}${bothText}`.includes(SECRET));
  assert.deepEqual(
    SecretSetSchema.parse(JSON.parse(bothText)).keys.map((member) => [member.kind, member.name]),
    [
      ["ApiKey", "ANTHROPIC_API_KEY"],
      ["Variable", "DEPLOY_TOKEN"],
    ],
  );

  const base = {
    name: "Piped",
    harness: "ClaudeCode",
    secretSetId,
    connectorIds: [],
    files: [{ source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from(REVIEWER_MEMORY).toString("base64") }],
  };
  const persona = await world.postJson("/v1/personas", base, bearer);
  assert.equal(persona.status, 200);
  const { personaId } = PersonaSchema.parse(await persona.json());
  const renamed = await send("PUT", `/v1/personas/${personaId}`, { ...base, name: "Piped again" });
  assert.equal(renamed.status, 200);
  const kept = PersonaSchema.parse(await renamed.json());
  assert.deepEqual(
    [kept.name, kept.secretSetId, kept.files.map((held) => [held.path, held.digest])],
    ["Piped again", secretSetId, [[".claude/CLAUDE.md", sha256(REVIEWER_MEMORY)]]],
  );

  const removed = await world.request(`/v1/secret-sets/${secretSetId}/members/ANTHROPIC_API_KEY`, {
    method: "DELETE",
    headers: bearer,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    SecretSetSchema.parse(await removed.json()).keys.map((member) => member.name),
    ["DEPLOY_TOKEN"],
  );
  const missing = await world.request(`/v1/secret-sets/${secretSetId}/members/ANTHROPIC_API_KEY`, {
    method: "DELETE",
    headers: bearer,
  });
  assert.equal(missing.status, 404);
  assert.match(ProblemSchema.parse(await missing.json()).detail, /no member ANTHROPIC_API_KEY/);
});
