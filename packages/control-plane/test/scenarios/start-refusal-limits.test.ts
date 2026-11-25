import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemSchema } from "@tumpel/schemas";
import { LIMITS, World } from "./harness/world.ts";
import { mcpPersona } from "./signal-fixtures.ts";

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
    assert.equal(world.tenantRowsWritten() - before, 2);
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
