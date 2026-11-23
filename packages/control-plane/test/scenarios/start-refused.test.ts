import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ListEventsResultSchema, ProblemSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import { z } from "zod";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("StartRefused coalesces a full host's crew starts and queues one Foreman delivery", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 1,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead the crew", tags: ["role:foreman"] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  const subscription = await world.subscribe(foreman, {
    prompt: "handle refused crew starts",
    goal: "finish the work",
    events: ["StartRefused"],
    crewTags: ["crew:work"],
  });
  const offer = host.takeOffer();
  await host.claims(offer);
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: offer.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(served.kind, "Served");
  const caller = { tenantId: TENANT_ID, token: served.token.accessToken };
  const before = world.tenantRowsWritten();
  const refuse = async (): Promise<void> => {
    const response = await world.fetch(
      caller,
      "POST",
      "/v1/sessions",
      JSON.stringify({
        personaId: foreman.personaId,
        repository: "https://github.com/acme/app",
        model: "opus",
        prompt: "do crew work",
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(ProblemSchema.parse(await response.json()).code, "PoolExhausted");
  };
  await refuse();
  const firstWrites = world.tenantRowsWritten() - before;
  assert.equal(firstWrites, 15);
  const afterFirst = world.tenantRowsWritten();
  for (let attempt = 0; attempt < 5; attempt++) await refuse();
  assert.equal(world.tenantRowsWritten() - afterFirst, 0);
  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["StartRefused"],
      sessionId: null,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  assert.equal(listed.page.events.length, 1);
  const event = listed.page.events[0];
  assert.equal(event?.event, "StartRefused");
  assert.equal(event.refusal.code, "PoolExhausted");
  assert.deepEqual(event.crewTags, ["crew:work"]);
  const pending = z
    .array(z.object({ subscription_id: z.string(), box_memory_mib: z.number(), box_disk_mib: z.number() }))
    .parse(
      world
        .tenantSql()
        .exec("SELECT subscription_id, box_memory_mib, box_disk_mib FROM subscription_pending_room")
        .toArray(),
    );
  assert.deepEqual(pending, [
    { subscription_id: subscription.subscriptionId, box_memory_mib: 2048, box_disk_mib: 32768 },
  ]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 1);

  const resized = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ boxMemoryMib: 4096 }),
  );
  assert.equal(resized.status, 200);
  const beforeResizeRefusal = world.tenantRowsWritten();
  await refuse();
  assert.equal(world.tenantRowsWritten() - beforeResizeRefusal, 2);
  const requirements = z
    .object({ box_memory_mib: z.number() })
    .parse(world.tenantSql().exec("SELECT box_memory_mib FROM subscription_pending_room").one());
  assert.equal(requirements.box_memory_mib, 4096);

  await host.completes(offer);
  const request = z.object({ snapshotId: z.string(), storageKey: z.string() }).parse(host.take("SnapshotRequest"));
  const manifest = JSON.stringify({ entries: [] });
  const digest = createHash("sha256").update(manifest).digest("hex");
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [{ packDigest: digest, sizeBytes: manifest.length }],
    reusedPackDigests: [],
    chunks: [{ digest, packDigest: digest, offset: 0, length: manifest.length }],
  });
  await world.store.put(`${TENANT_ID}/packs/${digest}`, manifest);
  await world.store.put(
    request.storageKey,
    JSON.stringify({ manifest: [{ digest, packDigest: digest, offset: 0, length: manifest.length }] }),
  );
  await host.says({
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: manifest.length,
    chunkCount: 1,
  });
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /StartRefused/);
  assert.match(delivery.prompt, /PoolExhausted/);
});
