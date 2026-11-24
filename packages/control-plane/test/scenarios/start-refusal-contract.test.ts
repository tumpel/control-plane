import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HostRecordSchema,
  ListEventsResultSchema,
  PatchSessionTagsResultSchema,
  PersonaSchema,
  StartSessionResultSchema,
} from "@tumpel/schemas";
import { CLAUDE_CODE_VERSION } from "../../src/harness-catalog.ts";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";

test("F1 records the refused start and rejects 17 inherited tags without writes", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "plan the work", tags: [] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  const persona = PersonaSchema.parse(await enabled.json());
  assert.equal(persona.tumpelMcp, true);
  const subscription = {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
    crewTags: ["crew:x"],
  };
  await world.subscribe(foreman, subscription);
  const offer = host.takeOffer();
  await host.claims(offer);
  assert.equal((await world.turn(offer.turnId)).state, "Running");
  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
  await world.settle();

  const sql = world.tenantStorage(TENANT_ID).sql;
  const logicalEvents = (): number => Number(sql.exec("SELECT COUNT(*) AS count FROM events").one().count);
  const list = { tenantId: TENANT_ID, events: ["StartRefused"], sessionId: null, triggerId: null };
  const cursor = ListEventsResultSchema.parse(await world.call("listEvents", { ...list, afterEventId: null })).listed;
  assert.equal(cursor.kind, "Read");
  const input = {
    tenantId: TENANT_ID,
    refusal: { code: "ModelUnsupported", detail: "The harness does not run this model." },
    caller: { kind: "Turn", sessionId: foreman.sessionId, turnId: offer.turnId },
    personaId: foreman.personaId,
    model: "unsupported",
    requestedTags: ["work:task"],
    now: Date.now(),
  } as const;
  const rowsBefore = logicalEvents();
  const meterBefore = world.tenantRowsWritten();
  assert.deepEqual(await world.call("recordStartRefusal", input), { kind: "Recorded" });
  assert.equal(logicalEvents() - rowsBefore, 1);
  assert.equal(world.tenantRowsWritten() - meterBefore, 3);
  const recorded = ListEventsResultSchema.parse(
    await world.call("listEvents", { ...list, afterEventId: cursor.page.lastEventId }),
  ).listed;
  assert.equal(recorded.kind, "Read");
  assert.deepEqual(recorded.page.events, [
    {
      eventId: cursor.page.lastEventId + 1,
      tenantId: TENANT_ID,
      createdAt: input.now,
      event: "StartRefused",
      operation: "Start",
      caller: input.caller,
      personaId: input.personaId,
      model: input.model,
      refusal: input.refusal,
      crewTags: ["crew:x", "work:task"],
    },
  ]);

  const extraCrewTags = Array.from({ length: 16 }, (_, index) => `crew:${index}`);
  await world.subscribe(foreman, { ...subscription, crewTags: extraCrewTags });
  const overflowRows = logicalEvents();
  const overflowMeter = world.tenantRowsWritten();
  const overflow = { kind: "TagsOverLimit", tagCount: 17 };
  assert.deepEqual(await world.call("recordStartRefusal", { ...input, requestedTags: ["crew:x"] }), overflow);
  assert.equal(logicalEvents() - overflowRows, 0);
  assert.equal(world.tenantRowsWritten() - overflowMeter, 0);

  host.report({ memoryHeldMib: 0 });
  await world.settle();
  const hostResponse = await world.fetch(world.owner, "GET", `/v1/hosts/${host.hostId}`);
  assert.equal(hostResponse.status, 200);
  const hostRecord = HostRecordSchema.parse(await hostResponse.json());
  const { started } = StartSessionResultSchema.parse(
    await world.call("startSession", {
      tenantId: TENANT_ID,
      input: {
        principalId: PRINCIPAL_ID,
        startedBy: input.caller,
        hosts: [hostRecord],
        harness: "ClaudeCode",
        harnessVersion: CLAUDE_CODE_VERSION,
        endpoint: "https://api.scenario.test",
        start: {
          personaId: foreman.personaId,
          prompt: "start work",
          model: "opus",
          repository: foreman.repository,
          tags: [],
        },
      },
      now: Date.now(),
    }),
  );
  assert.deepEqual(started, overflow);
  const tagged = await world.fetch(
    world.owner,
    "PUT",
    `/v1/sessions/${foreman.sessionId}/tags`,
    JSON.stringify({ tags: extraCrewTags }),
  );
  assert.equal(tagged.status, 200, await tagged.clone().text());
  const result = PatchSessionTagsResultSchema.parse(
    await world.call("patchSessionTags", {
      tenantId: TENANT_ID,
      sessionId: foreman.sessionId,
      patch: { add: ["crew:x"] },
      now: Date.now(),
    }),
  );
  assert.deepEqual(result.tagged, overflow);
});
