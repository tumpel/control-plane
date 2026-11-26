import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaMetadataListSchema, TriggerSchema } from "@tumpel/schemas";
import { World } from "./harness/world.ts";

const CONDITION_VALUES = 4;

test("an Owner's untargeted trigger reads back without a target, its create writes 3 + 2v rows in each store, and its reads write none", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const [persona] = PersonaMetadataListSchema.parse(
    await (await world.fetch(world.owner, "GET", "/v2/personas")).json(),
  );
  assert.ok(persona);

  const tenantBefore = world.tenantRowsWritten();
  const centralBefore = world.db.sql.rowsWritten;
  const created = await world.fetch(
    world.owner,
    "POST",
    "/v1/triggers",
    JSON.stringify({
      name: "agent-review",
      source: {
        kind: "GitHub",
        event: "status",
        conditions: [
          { field: "repository.full_name", values: ["acme/app"] },
          { field: "context", values: ["agent-review"] },
          { field: "state", values: ["success", "failure"] },
        ],
      },
      personaId: persona.personaId,
      model: "opus",
      prompt: "Review {{sha}}",
    }),
  );
  assert.equal(created.status, 200, await created.clone().text());
  const trigger = TriggerSchema.parse(await created.json());
  assert.equal(world.tenantRowsWritten() - tenantBefore, 3 + 2 * CONDITION_VALUES);
  assert.equal(world.db.sql.rowsWritten - centralBefore, 3 + 2 * CONDITION_VALUES);
  assert.equal(trigger.sessionId, undefined);

  const tenantRead = world.tenantRowsWritten();
  const centralRead = world.db.sql.rowsWritten;
  const got = TriggerSchema.parse(
    await (await world.fetch(world.owner, "GET", `/v1/triggers/${trigger.triggerId}`)).json(),
  );
  const listed = TriggerSchema.array().parse(await (await world.fetch(world.owner, "GET", "/v1/triggers")).json());
  assert.deepEqual(got, trigger);
  assert.deepEqual(listed, [trigger]);
  assert.equal(world.tenantRowsWritten() - tenantRead, 0);
  assert.equal(world.db.sql.rowsWritten - centralRead, 0);
});
