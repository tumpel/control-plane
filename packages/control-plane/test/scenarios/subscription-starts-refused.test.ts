import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionSchema } from "@tumpel/schemas";
import { TENANT_ID, World } from "./harness/world.ts";

test("Fixture StartsRefused shows the pause through the API and resumes with 5 writes", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "plan the work", tags: [] });
  const create = {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused"],
    crewTags: [],
  };
  const { subscriptionId } = await world.subscribe(foreman, create);
  const crew = await world.subscribe(foreman, create);
  const now = Date.now();
  const storage = world.tenantStorage(TENANT_ID);
  const sql = storage.sql;
  const tenant = world.tenantSteps();
  const crewRow = tenant.subscriptionRow(crew.subscriptionId);
  const refusalRow = tenant.subscriptionRow(subscriptionId);
  assert.ok(crewRow);
  assert.ok(refusalRow);
  const crewBefore = world.tenantRowsWritten();
  storage.transactionSync(() => tenant.pause(crewRow, { kind: "CrewFailing" }, now));
  assert.equal(world.tenantRowsWritten() - crewBefore, 10);

  sql.exec("UPDATE subscriptions SET starts_refused_in_a_row = 10 WHERE subscription_id = ?", subscriptionId);
  const refusalBefore = world.tenantRowsWritten();
  storage.transactionSync(() => tenant.pause(refusalRow, { kind: "StartsRefused" }, now));
  assert.equal(world.tenantRowsWritten() - refusalBefore, 10);

  const path = `/v1/subscriptions/${subscriptionId}`;
  const paused = await world.fetch(world.owner, "GET", path);
  assert.equal(paused.status, 200);
  const presented = SubscriptionSchema.parse(await paused.json());
  assert.equal(presented.state, "Paused");
  assert.deepEqual(presented.reason, { kind: "StartsRefused" });
  assert.equal(presented.pausedAt, new Date(now).toISOString());
  assert.equal(
    sql
      .exec(
        "SELECT COUNT(*) AS count FROM subscription_starts_refused_pauses WHERE subscription_id = ?",
        subscriptionId,
      )
      .one().count,
    1,
  );

  const before = world.tenantRowsWritten();
  const resumed = await world.fetch(world.owner, "POST", `${path}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(SubscriptionSchema.parse(await resumed.json()).state, "Active");
  assert.equal(world.tenantRowsWritten() - before, 5);
  assert.equal(
    sql
      .exec(
        "SELECT COUNT(*) AS count FROM subscription_starts_refused_pauses WHERE subscription_id = ?",
        subscriptionId,
      )
      .one().count,
    0,
  );
  assert.equal(
    sql.exec("SELECT starts_refused_in_a_row FROM subscriptions WHERE subscription_id = ?", subscriptionId).one()
      .starts_refused_in_a_row,
    0,
  );
});
