import assert from "node:assert/strict";
import { test } from "node:test";
import { HostRecordSchema, ProblemSchema, SendTurnResultSchema, StartRefusalSchema } from "@tumpel/schemas";
import { LIMITS, PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

test("a storm of refused starts spends the existing tenant write limit", async (t) => {
  const world = await World.open({
    limits: { ...LIMITS, writesPerMinute: 5, ceiling: { ...LIMITS.ceiling, writesPerMinute: 5 } },
  });
  t.after(() => world.close());
  const personaId = await mcpPersona(world);
  await world.tick(60_000);
  const start = JSON.stringify({
    personaId,
    repository: "https://github.com/acme/app",
    prompt: "start the work",
    model: "unsupported-model",
  });
  const count = () =>
    world
      .tenantSql()
      .exec("SELECT COUNT(*) AS count FROM events WHERE json_extract(payload, '$.event') = 'StartRefused'")
      .one().count;
  for (let refused = 1; refused <= 5; refused++) {
    const before = world.tenantRowsWritten();
    const response = await world.fetch(world.owner, "POST", "/v1/sessions", start);
    assert.equal(response.status, 422);
    assert.equal(ProblemSchema.parse(await response.json()).code, "ModelUnsupported");
    assert.equal(count(), refused);
    assert.equal(world.tenantRowsWritten() - before, 3);
  }
  const before = world.tenantRowsWritten();
  const response = await world.fetch(world.owner, "POST", "/v1/sessions", start);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "RateLimited");
  assert.match(problem.detail, /more than 5 writing requests in a minute/);
  assert.equal(count(), 5);
  assert.equal(world.tenantRowsWritten() - before, 0);
});

test("a refused send with many unavailable hosts stores the same bounded detail in one event", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const personaId = await mcpPersona(world);
  const { session, offer } = await startBox(world, host, personaId, "start the work", "Warm");
  await host.finishes(offer);
  await host.dropsIdleBox(offer);
  assert.equal((await world.session(session.sessionId)).state, "Stopped");
  const response = await world.fetch(world.owner, "GET", `/v1/hosts/${host.hostId}`);
  assert.equal(response.status, 200);
  const record = HostRecordSchema.parse(await response.json());
  const hosts = Array.from({ length: 200 }, (_, index) => ({
    ...record,
    hostId: `unavailable-${index}`,
    name: `Host ${index} ${"x".repeat(80)}`,
    state: "Offline",
  }));
  const fullDetail = `no host of your tenant is healthy: ${hosts
    .map(
      ({ name }) =>
        `${name} has not reported to the control plane within its heartbeat grace and counts as Degraded until it sends a heartbeat`,
    )
    .join(", ")}`;
  const bound = StartRefusalSchema.shape.detail.maxLength;
  assert.ok(bound !== null && fullDetail.length > bound);

  const before = world.tenantRowsWritten();
  const { sent } = SendTurnResultSchema.parse(
    await world.call("sendTurn", {
      tenantId: TENANT_ID,
      caller: { kind: "Person", principalId: PRINCIPAL_ID },
      sessionId: session.sessionId,
      send: { prompt: "continue the work" },
      hosts,
      now: Date.now(),
    }),
  );
  assert.equal(sent.kind, "Unplaced");
  assert.equal(world.tenantRowsWritten() - before, 3);
  const stored = world
    .tenantSql()
    .exec(`
    SELECT json_extract(payload, '$.refusal') AS refusal
    FROM events WHERE json_extract(payload, '$.event') = 'StartRefused'`)
    .toArray();
  assert.equal(stored.length, 1);
  assert.deepEqual(StartRefusalSchema.parse(JSON.parse(String(stored[0]?.refusal))), {
    code: "HostDegraded",
    detail: fullDetail.slice(0, bound).toWellFormed(),
  });
});
