import assert from "node:assert/strict";
import { test } from "node:test";
import { WebhookEndpointSchema } from "@tumpel/schemas";
import { z } from "zod";
import { TENANT_ID, World } from "./harness/world.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const endpointOf = async (world: World, webhookEndpointId: string) =>
  z
    .object({ endpoint: WebhookEndpointSchema })
    .parse(await world.call("getWebhookEndpoint", { tenantId: TENANT_ID, webhookEndpointId })).endpoint;

test("a webhook endpoint that always answers 500 gets 10 retries with growing gaps, then the delivery fails hard", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const posts: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    posts.push(Date.now());
    return new Response(null, { status: 500 });
  });

  const { endpoint } = z.object({ endpoint: WebhookEndpointSchema }).parse(
    await world.call("createWebhookEndpoint", {
      tenantId: TENANT_ID,
      endpoint: { url: "https://hooks.scenario.test/events", events: ["HostOnline"] },
      now: Date.now(),
    }),
  );
  const failingSince = new Date(Date.now()).toISOString();
  await world.call("hostPresence", { tenantId: TENANT_ID, hostId: "host-1", presence: "Online", now: Date.now() });
  await world.passes(2 * DAY);

  assert.equal(posts.length, 11, "the first post and 10 retries");
  const gaps = posts.slice(1).map((at, index) => at - (posts[index] ?? 0));
  assert.ok((gaps[0] ?? 0) >= MINUTE / 2 && (gaps[0] ?? 0) <= MINUTE, `first gap ${gaps[0]}`);
  for (const [index, gap] of gaps.entries()) {
    if (index > 0) assert.ok(gap >= (gaps[index - 1] ?? 0), `gap ${index + 1} (${gap}) shrank`);
  }
  assert.deepEqual((await endpointOf(world, endpoint.webhookEndpointId)).status, {
    delivery: "Failing",
    detail: "HTTP 500; still failing after 10 retries",
    failingSince,
  });

  await world.call("hostPresence", { tenantId: TENANT_ID, hostId: "host-1", presence: "Offline", now: Date.now() });
  await world.passes(7 * DAY);
  assert.equal(posts.length, 11, "a failing endpoint gets no more posts");
});

test("a webhook endpoint that answers 400 fails hard on the first post", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const posts: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    posts.push(Date.now());
    return new Response(null, { status: 400 });
  });

  const { endpoint } = z.object({ endpoint: WebhookEndpointSchema }).parse(
    await world.call("createWebhookEndpoint", {
      tenantId: TENANT_ID,
      endpoint: { url: "https://hooks.scenario.test/events", events: ["HostOnline"] },
      now: Date.now(),
    }),
  );
  await world.call("hostPresence", { tenantId: TENANT_ID, hostId: "host-1", presence: "Online", now: Date.now() });
  await world.passes(DAY);

  assert.equal(posts.length, 1);
  assert.equal((await endpointOf(world, endpoint.webhookEndpointId)).status.delivery, "Failing");
  assert.match(
    JSON.stringify((await endpointOf(world, endpoint.webhookEndpointId)).status),
    /HTTP 400; retrying cannot fix this/,
  );
});
