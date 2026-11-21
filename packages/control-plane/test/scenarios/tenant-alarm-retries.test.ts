import assert from "node:assert/strict";
import { test } from "node:test";
import { TENANT_ID, World } from "./harness/world.ts";

const SECOND = 1000;
const DAY = 24 * 3_600_000;

test("tenant work that always throws runs 11 times with growing gaps, then fails hard and stops re-arming", async (t) => {
  const world = await World.open({ webhookSenders: "Unreachable" });
  t.after(() => world.close());
  const logged: { at: number; line: string }[] = [];
  t.mock.method(console, "error", (line: string) => logged.push({ at: Date.now(), line }));

  await world.call("createWebhookEndpoint", {
    tenantId: TENANT_ID,
    endpoint: { url: "https://hooks.scenario.test/events", events: ["HostOnline"] },
    now: Date.now(),
  });
  await world.call("hostPresence", { tenantId: TENANT_ID, hostId: "host-1", presence: "Online", now: Date.now() });
  await world.passes(DAY);

  const lines = logged.map(({ line }) => line);
  assert.equal(lines.length, 11, "the first run and 10 retries");
  for (const [index, line] of lines.slice(0, 10).entries()) {
    assert.match(line, new RegExp(`^TenantAlarmRetry: tenant ${TENANT_ID} retry ${index + 1} of 10: `));
  }
  assert.match(
    lines[10] ?? "",
    /^TenantAlarmFailed: tenant tenant-scenario stopped retrying its alarm work after 10 retries; the next request starts it again: the webhook sender Durable Object is unreachable$/,
  );

  const gaps = logged.slice(1).map(({ at }, index) => at - (logged[index]?.at ?? 0));
  assert.ok((gaps[0] ?? 0) >= 1 * SECOND && (gaps[0] ?? 0) <= 2 * SECOND, `first gap ${gaps[0]}`);
  for (const [index, gap] of gaps.entries()) {
    if (index > 0) assert.ok(gap >= (gaps[index - 1] ?? 0), `gap ${index + 1} (${gap}) shrank`);
  }
  assert.ok((gaps[9] ?? 0) >= 512 * SECOND, `last gap ${gaps[9]}`);

  assert.equal(await world.tenantAlarm(), null);
  await world.passes(7 * DAY);
  assert.equal(logged.length, 11, "no run after the hard failure");
});
