import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaSchema, ProblemSchema, SecretSetSchema, TriggerSchema } from "@tumpel/schemas";
import type { World } from "./harness/world.ts";
import { startBox } from "./signal-fixtures.ts";
import { foremanIdle, statusTrigger, tool } from "./trigger-fixtures.ts";

const CONDITION_VALUES = 4;
const TARGETED_CREATE_TENANT_ROWS = 3 + 2 * CONDITION_VALUES + 3;
const TARGETED_CREATE_CENTRAL_ROWS = 3 + 2 * CONDITION_VALUES;

const configApply = async (world: World, triggerNames: string[]) => {
  const [persona] = PersonaSchema.array().parse(await (await world.fetch(world.owner, "GET", "/v1/personas")).json());
  assert.ok(persona);
  const secretSet = SecretSetSchema.parse(
    await (await world.fetch(world.owner, "GET", `/v1/secret-sets/${persona.secretSetId}`)).json(),
  );
  return {
    config: {
      personas: [
        {
          name: persona.name,
          harness: persona.harness,
          secretSetName: secretSet.name,
          connectorNames: [],
          files: [],
          tumpelMcp: true,
        },
      ],
      secretSets: [{ name: secretSet.name, secrets: [] }],
      harnessPins: [],
      hosts: [],
      triggers: triggerNames.map((name) => {
        const { personaId: _, ...trigger } = statusTrigger(name, persona.personaId);
        return { ...trigger, personaName: persona.name };
      }),
    },
    files: [],
    secretValues: [],
    expiryValues: [],
  };
};

test("a Foreman's turn token creates, reads and deletes only triggers that target its own session", async (t) => {
  const { world, host, personaId, foreman, token, rows, written, ownerCreate } = await foremanIdle(t);
  const foremanId = foreman.session.sessionId;

  const before = rows();
  const created = await tool(world, token, "tumpel_trigger_create", statusTrigger("wake-pr-7", personaId, foremanId));
  assert.ok(created.ok, created.text);
  assert.deepEqual(written(before), { tenant: TARGETED_CREATE_TENANT_ROWS, central: TARGETED_CREATE_CENTRAL_ROWS });
  const trigger = TriggerSchema.parse(JSON.parse(created.text));
  assert.equal(trigger.sessionId, foremanId);
  const listed = await tool(world, token, "tumpel_trigger_list", {});
  assert.deepEqual(TriggerSchema.array().parse(JSON.parse(listed.text)), [trigger]);
  const got = await tool(world, token, "tumpel_trigger_get", { triggerId: trigger.triggerId });
  assert.deepEqual(TriggerSchema.parse(JSON.parse(got.text)), trigger);

  const crew = await startBox(world, host, personaId, "build the change", "Warm");
  const other = await ownerCreate("wake-crew", crew.session.sessionId);
  assert.equal(other.status, 200, await other.clone().text());
  const { triggerId: otherId } = TriggerSchema.parse(await other.json());
  const untargeted = await ownerCreate("owner-review");
  assert.equal(untargeted.status, 200);
  const owned = TriggerSchema.parse(await untargeted.json());

  const refusals: [string, Record<string, unknown>][] = [
    ["tumpel_trigger_delete", { triggerId: otherId }],
    ["tumpel_trigger_create", statusTrigger("sneaky", personaId)],
    ["tumpel_trigger_create", statusTrigger("sneaky", personaId, crew.session.sessionId)],
    ["tumpel_trigger_update", { triggerId: owned.triggerId, prompt: "changed" }],
    ["tumpel_trigger_update", { triggerId: trigger.triggerId, prompt: "changed" }],
    ["tumpel_config_apply", await configApply(world, ["config-review"])],
  ];
  for (const [name, args] of refusals) {
    const quiet = rows();
    const refused = await tool(world, token, name, args);
    assert.equal(refused.ok, false, `${name} was not refused`);
    assert.match(refused.text, /^Forbidden: /, `${name}: ${refused.text}`);
    assert.deepEqual(written(quiet), { tenant: 0, central: 0 }, name);
  }

  const collision = await tool(
    world,
    token,
    "tumpel_trigger_create",
    statusTrigger("owner-review", personaId, foremanId),
  );
  assert.equal(collision.ok, false);
  assert.match(collision.text, /^Conflict: /);

  const ownerUpdate = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/triggers/${trigger.triggerId}`,
    JSON.stringify({ prompt: "changed" }),
  );
  assert.equal(ownerUpdate.status, 400);
  assert.match(await ownerUpdate.text(), /delete the trigger and create a new one/i);

  const removed = await tool(world, token, "tumpel_trigger_delete", { triggerId: trigger.triggerId });
  assert.ok(removed.ok, removed.text);
  assert.equal(
    (await world.db.prepare("SELECT 1 FROM trigger_routes WHERE trigger_id = ?").bind(trigger.triggerId).first()) ??
      null,
    null,
  );
});

test("targets are refused past 10 per session and 50 per tenant, and a create writes the same rows on a full tenant", async (t) => {
  const { world, host, personaId, foreman, token, rows, written, ownerCreate } = await foremanIdle(t);
  const foremanId = foreman.session.sessionId;
  for (let index = 0; index < 10; index += 1) {
    const created = await tool(
      world,
      token,
      "tumpel_trigger_create",
      statusTrigger(`f-${index}`, personaId, foremanId),
    );
    assert.ok(created.ok, created.text);
  }
  const quiet = rows();
  const eleventh = await tool(world, token, "tumpel_trigger_create", statusTrigger("f-10", personaId, foremanId));
  assert.equal(eleventh.ok, false);
  assert.match(eleventh.text, /^TriggerLimitReached: /);
  assert.match(eleventh.text, new RegExp(`session ${foremanId} already has 10 targeted triggers`));
  assert.deepEqual(written(quiet), { tenant: 0, central: 0 });

  const crews: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    crews.push((await startBox(world, host, personaId, `crew ${index}`, "Warm")).session.sessionId);
  }
  for (const [crewIndex, crewId] of crews.slice(0, 4).entries()) {
    for (let index = 0; index < 10; index += 1) {
      const fiftieth = crewIndex === 3 && index === 9;
      const before = rows();
      const created = await ownerCreate(`c-${crewIndex}-${index}`, crewId);
      assert.equal(created.status, 200, await created.clone().text());
      if (fiftieth) {
        assert.deepEqual(written(before), {
          tenant: TARGETED_CREATE_TENANT_ROWS,
          central: TARGETED_CREATE_CENTRAL_ROWS,
        });
      }
    }
  }
  const full = rows();
  const fiftyFirst = await ownerCreate("c-51", crews[4]);
  assert.equal(fiftyFirst.status, 409);
  const problem = await fiftyFirst.text();
  assert.match(problem, /TriggerLimitReached/);
  assert.match(problem, /your tenant already has 50 targeted triggers/);
  assert.deepEqual(written(full), { tenant: 0, central: 0 });
});

test("a targeted create is refused for a mismatched persona or model, and deleting the Foreman deletes its triggers and routes", async (t) => {
  const { world, host, personaId, foreman, token, ownerCreate } = await foremanIdle(t);
  const foremanId = foreman.session.sessionId;
  const mismatch = await tool(world, token, "tumpel_trigger_create", {
    ...statusTrigger("wake-sonnet", personaId, foremanId),
    model: "sonnet",
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.text, new RegExp(`session ${foremanId} runs persona ${personaId} with model opus`));

  const ids: string[] = [];
  for (const name of ["wake-checks", "wake-review"]) {
    const created = await tool(world, token, "tumpel_trigger_create", statusTrigger(name, personaId, foremanId));
    assert.ok(created.ok, created.text);
    ids.push(TriggerSchema.parse(JSON.parse(created.text)).triggerId);
  }
  const kept = await ownerCreate("owner-review");
  assert.equal(kept.status, 200);

  await host.finishes(foreman.offer);
  await world.settle();
  const deleted = await world.fetch(world.owner, "DELETE", `/v1/sessions/${foremanId}`);
  assert.equal(deleted.status, 204, await deleted.clone().text());

  const sql = world.tenantSql();
  const held = (table: string): number =>
    Number(sql.exec(`SELECT COUNT(*) AS held FROM ${table} WHERE trigger_id IN (?, ?)`, ids[0], ids[1]).one().held);
  assert.equal(held("triggers"), 0);
  assert.equal(held("trigger_conditions"), 0);
  assert.equal(held("trigger_session_targets"), 0);
  for (const triggerId of ids) {
    assert.equal(
      (await world.db.prepare("SELECT 1 FROM trigger_routes WHERE trigger_id = ?").bind(triggerId).first()) ?? null,
      null,
    );
  }
  const left = TriggerSchema.array().parse(await (await world.fetch(world.owner, "GET", "/v1/triggers")).json());
  assert.deepEqual(
    left.map((trigger) => trigger.name),
    ["owner-review"],
  );
});

test("an Owner's config apply keeps the Foreman's armed trigger, and a config trigger of its name fails the plan", async (t) => {
  const { world, personaId, foreman, token } = await foremanIdle(t);
  const created = await tool(
    world,
    token,
    "tumpel_trigger_create",
    statusTrigger("wake-pr-7", personaId, foreman.session.sessionId),
  );
  assert.ok(created.ok, created.text);
  const armed = TriggerSchema.parse(JSON.parse(created.text));
  const listed = async () =>
    TriggerSchema.array().parse(await (await world.fetch(world.owner, "GET", "/v1/triggers")).json());

  const applied = await world.fetch(
    world.owner,
    "POST",
    "/v1/tenant-config/apply",
    JSON.stringify(await configApply(world, [])),
  );
  assert.equal(applied.status, 200, await applied.clone().text());
  assert.deepEqual(await listed(), [armed]);

  const colliding = await world.fetch(
    world.owner,
    "POST",
    "/v1/tenant-config/apply",
    JSON.stringify(await configApply(world, ["wake-pr-7"])),
  );
  assert.equal(colliding.status, 422);
  const problem = ProblemSchema.parse(await colliding.json());
  assert.equal(problem.code, "InvalidRequest");
  assert.match(
    problem.detail,
    new RegExp(
      `has the name of targeted trigger ${armed.triggerId}, which waits for session ${foreman.session.sessionId}`,
    ),
  );
  assert.deepEqual(await listed(), [armed]);
});

test("a targeted create is refused NotFound for an unknown session and SessionArchived for an archived one, writing 0", async (t) => {
  const { world, host, personaId, rows, written, ownerCreate } = await foremanIdle(t);
  const quiet = rows();
  const unknown = await ownerCreate("wake-nobody", "ses-unknown");
  assert.equal(unknown.status, 404);
  const missing = ProblemSchema.parse(await unknown.json());
  assert.equal(missing.code, "NotFound");
  assert.match(missing.detail, /no session ses-unknown to target/);
  assert.deepEqual(written(quiet), { tenant: 0, central: 0 });

  const crew = await startBox(world, host, personaId, "build the change", "Warm");
  await host.finishes(crew.offer);
  await world.settle();
  const archived = await world.fetch(world.owner, "POST", `/v1/sessions/${crew.session.sessionId}/archive`);
  assert.equal(archived.status, 200, await archived.clone().text());
  const before = rows();
  const refused = await ownerCreate("wake-archived", crew.session.sessionId);
  assert.equal(refused.status, 409);
  assert.equal(ProblemSchema.parse(await refused.json()).code, "SessionArchived");
  assert.deepEqual(written(before), { tenant: 0, central: 0 });
});
