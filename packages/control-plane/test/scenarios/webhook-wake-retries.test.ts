import assert from "node:assert/strict";
import { test } from "node:test";
import { TENANT_ID, World } from "./harness/world.ts";

const SECOND = 1000;
const DAY = 24 * 3_600_000;

const gapsOf = (times: number[]): number[] => times.slice(1).map((at, index) => at - (times[index] ?? 0));

test("a webhook wake that always fails is tried 11 times with growing gaps, then dropped, and requests neither hurry nor restart it", async (t) => {
  const world = await World.open({ webhookSenders: "Unreachable" });
  t.after(() => world.close());
  const logged: { at: number; line: string }[] = [];
  t.mock.method(console, "error", (line: string) => logged.push({ at: Date.now(), line }));
  const presence = (presence: "Online" | "Offline") =>
    world.call("hostPresence", { tenantId: TENANT_ID, hostId: "host-1", presence, now: Date.now() });

  await world.call("createWebhookEndpoint", {
    tenantId: TENANT_ID,
    endpoint: { url: "https://hooks.scenario.test/events", events: ["HostOnline"] },
    now: Date.now(),
  });
  await presence("Online");
  assert.equal(logged.length, 1, "the request tries the wake once");
  await presence("Offline");
  await presence("Offline");
  assert.equal(logged.length, 1, "requests during the backoff do not try the wake again");

  await world.passes(DAY);
  const lines = logged.map(({ line }) => line);
  assert.equal(lines.length, 11, "the first try and 10 retries");
  for (const [index, line] of lines.slice(0, 10).entries()) {
    assert.match(
      line,
      new RegExp(`^WebhookWakeRetry: tenant ${TENANT_ID} retry ${index + 1} of 10 to wake webhook endpoint `),
    );
  }
  assert.match(
    lines[10] ?? "",
    /^WebhookWakeFailed: tenant tenant-scenario dropped the wake of webhook endpoint \S+ after 10 retries; the next matching event wakes it again: the webhook sender Durable Object is unreachable$/,
  );
  const gaps = gapsOf(logged.map(({ at }) => at));
  assert.ok((gaps[0] ?? 0) >= 1 * SECOND && (gaps[0] ?? 0) <= 2 * SECOND, `first gap ${gaps[0]}`);
  for (const [index, gap] of gaps.entries()) {
    if (index > 0) assert.ok(gap >= (gaps[index - 1] ?? 0), `gap ${index + 1} (${gap}) shrank`);
  }
  assert.equal(await world.tenantAlarm(), null);

  await presence("Offline");
  await presence("Offline");
  await world.passes(7 * DAY);
  assert.equal(logged.length, 11, "requests after the hard failure try nothing");
});
