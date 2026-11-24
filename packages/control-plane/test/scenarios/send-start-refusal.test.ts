import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaSchema, ProblemSchema, SetSecretMemberResultSchema, StartRefusedEventSchema } from "@tumpel/schemas";
import { z } from "zod";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { SETTINGS, TENANT_ID, World } from "./harness/world.ts";

for (const { fixture, code, status } of [
  { fixture: "Offline with a missing snapshot", code: "HostOffline", status: 409 },
  { fixture: "Expired credential", code: "CredentialExpired", status: 422 },
  { fixture: "Stopped on a full host", code: "PoolExhausted", status: 409 },
  { fixture: "Stopped with an unreadable release", code: "ImageNotReleased", status: 422 },
] as const) {
  test(`Fixture ${fixture} records a refused send with its target tags`, async (t) => {
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
    if (code === "PoolExhausted" || code === "ImageNotReleased") {
      await host.dropsIdleBox(offer);
      assert.equal((await world.session(session.sessionId)).state, "Stopped");
    }
    if (code === "PoolExhausted") {
      host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
      await world.settle();
    }
    if (code === "ImageNotReleased") {
      await world.releases.put("current.json", "unreadable release");
      await world.passes(30_001);
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
    assert.equal(world.tenantRowsWritten() - before, 3);

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
