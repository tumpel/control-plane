import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaSchema, ProblemSchema, SetSecretMemberResultSchema, StartRefusedEventSchema } from "@tumpel/schemas";
import { z } from "zod";
import { RELEASE_CACHE_MS } from "../../src/releases.ts";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { SETTINGS, TENANT_ID, World } from "./harness/world.ts";

for (const { target, code, status } of [
  { target: "an offline host with no snapshot", code: "HostOffline", status: 409 },
  { target: "an expired credential", code: "CredentialExpired", status: 422 },
  { target: "a stopped session on a full host", code: "PoolExhausted", status: 409 },
] as const) {
  test(`a send refused for ${target} records ${code} with the session's tags`, async (t) => {
    const world = await World.open();
    t.after(() => world.close());
    await world.holdsAgentCredentials();
    const host = await world.hostOnline("host-1");
    const session = await world.startSession({ prompt: "start work", tags: ["crew:x", "work:task"] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.finishes(offer);

    const sql = world.tenantStorage(TENANT_ID).sql;
    if (code === "HostOffline") {
      sql.exec("DELETE FROM snapshots WHERE session_id = ?", session.sessionId);
      host.quiet();
      await world.passes(SETTINGS.heartbeatDeadlineSeconds * 1000 + 1);
    }
    if (code === "CredentialExpired") {
      const found = await world.fetch(world.owner, "GET", `/v1/personas/${session.personaId}`);
      const { secretSetId } = PersonaSchema.parse(await found.json());
      const now = Date.now();
      await world.call("removeSecretMember", { tenantId: TENANT_ID, secretSetId, name: "ANTHROPIC_API_KEY", now });
      const { set } = SetSecretMemberResultSchema.parse(
        await world.call("setSecretMember", {
          tenantId: TENANT_ID,
          secretSetId,
          member: {
            kind: "SubscriptionToken",
            name: "CLAUDE_TOKEN",
            provider: "Anthropic",
            expiresAt: new Date(now + 1_000).toISOString(),
            value: "test-subscription-token",
          },
          githubUser: null,
          now,
        }),
      );
      assert.equal(set.kind, "Set");
      await world.passes(2_000);
    }
    if (code === "PoolExhausted") {
      await host.dropsIdleBox(offer);
      assert.equal((await world.session(session.sessionId)).state, "Stopped");
      host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
      await world.settle();
    }

    const count = (): number => Number(sql.exec("SELECT COUNT(*) AS count FROM events").one().count);
    const rows = count();
    const before = world.tenantRowsWritten();
    const refused = await world.fetch(
      world.owner,
      "POST",
      `/v1/sessions/${session.sessionId}/turns`,
      JSON.stringify({ prompt: "continue work" }),
    );
    assert.equal(refused.status, status);
    const problem = ProblemSchema.parse(await refused.json());
    assert.equal(problem.code, code);
    assert.equal(count() - rows, 1);
    assert.equal(world.tenantRowsWritten() - before, 2);

    const listed = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
    assert.equal(listed.status, 200);
    const { events } = z.object({ events: StartRefusedEventSchema.array() }).parse(await listed.json());
    assert.deepEqual(
      events.map(({ operation, refusal, caller, crewTags, personaId, model }) => ({
        operation,
        refusal,
        caller: caller.kind,
        crewTags,
        personaId,
        model,
      })),
      [
        {
          operation: "Send",
          refusal: { code, detail: problem.detail },
          caller: "Person",
          crewTags: session.tags,
          personaId: session.personaId,
          model: session.model,
        },
      ],
    );
  });
}

test("a send refused for an unreadable release records no refusal", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "start work", tags: ["crew:x", "work:task"] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.finishes(offer);
  await host.dropsIdleBox(offer);
  assert.equal((await world.session(session.sessionId)).state, "Stopped");
  await world.releases.put("current.json", "unreadable release");
  await world.passes(RELEASE_CACHE_MS + 1);

  const before = world.tenantRowsWritten();
  const refused = await world.fetch(
    world.owner,
    "POST",
    `/v1/sessions/${session.sessionId}/turns`,
    JSON.stringify({ prompt: "continue work" }),
  );
  assert.equal(refused.status, 422);
  assert.equal(ProblemSchema.parse(await refused.json()).title, "The published release is unreadable");
  assert.equal(world.tenantRowsWritten() - before, 0);
  const listed = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
  const { events } = z.object({ events: StartRefusedEventSchema.array() }).parse(await listed.json());
  assert.deepEqual(events, []);
});
