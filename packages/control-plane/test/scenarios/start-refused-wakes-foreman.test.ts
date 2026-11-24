import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrepareOfferResultSchema,
  ProblemSchema,
  StartedSessionSchema,
  StartRefusedEventSchema,
  TenantEventSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { type Member, SETTINGS, TENANT_ID, type TurnOffer, World } from "./harness/world.ts";
import { mcpPersona } from "./signal-fixtures.ts";

for (const code of ["HarnessNotInCatalog", "ModelUnsupported"] as const) {
  test(`F1 wakes the Foreman after ${code} and resets when its retry starts crew`, async (t) => {
    const world = await World.open({ vars: { TUMPEL_SETTINGS: { ...SETTINGS, turnTotalBudgetSeconds: 7_200 } } });
    t.after(() => world.close());
    const host = await world.hostOnline("host-1");
    const personaId = await mcpPersona(world);
    const start = {
      personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "plan the work",
      boxRetention: "Warm",
    };
    const started = await world.fetch(world.owner, "POST", "/v1/sessions", JSON.stringify(start));
    assert.equal(started.status, 200);
    const { session: foreman } = StartedSessionSchema.parse(await started.json());
    const subscription = await world.subscribe(foreman, {
      prompt: "Continue the work",
      goal: "Land the work",
      events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
      crewTags: ["crew:x"],
    });
    const takeTurn = async (): Promise<{ offer: TurnOffer; member: Member }> => {
      const offer = host.takeOffer();
      assert.equal(offer.sessionId, foreman.sessionId);
      const { prepared } = PrepareOfferResultSchema.parse(
        await world.call("prepareOffer", {
          tenantId: TENANT_ID,
          turnId: offer.turnId,
          hostId: host.hostId,
          now: Date.now(),
        }),
      );
      assert.equal(prepared.kind, "Ready");
      const connector = prepared.credential.connectors.find(({ connectorId }) => connectorId === "tumpel");
      assert.ok(connector);
      await host.claims(offer);
      const response = await world.request(new URL(connector.tokenUrl).pathname, {
        method: "POST",
        headers: { authorization: `Bearer ${connector.tokenCredential}` },
      });
      assert.equal(response.status, 200);
      const { accessToken } = z.object({ accessToken: z.string() }).parse(await response.json());
      return { offer, member: { ...world.owner, token: accessToken } };
    };
    const foremanTurn = await takeTurn();
    host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
    await world.settle();
    host.quiet();

    const sql = world.tenantSql();
    const count = (event: string): number =>
      Number(
        sql.exec("SELECT COUNT(*) AS count FROM events WHERE json_extract(payload, '$.event') = ?", event).one().count,
      );
    const deliveries = (): number =>
      Number(
        sql
          .exec(
            "SELECT COUNT(*) AS count FROM subscription_turns WHERE subscription_id = ?",
            subscription.subscriptionId,
          )
          .one().count,
      );
    const counter = (): number =>
      Number(
        sql
          .exec(
            "SELECT starts_refused_in_a_row FROM subscriptions WHERE subscription_id = ?",
            subscription.subscriptionId,
          )
          .one().starts_refused_in_a_row,
      );
    const quiet = world.tenantRowsWritten();
    await world.tick(3_600_000);
    assert.equal(world.tenantRowsWritten() - quiet, 0);
    assert.equal(count("StartRefused"), 0);
    assert.equal(deliveries(), 0);
    await host.beats();
    assert.equal((await world.turn(foremanTurn.offer.turnId)).state, "Running");

    if (code === "HarnessNotInCatalog") {
      await world.call("pin", { pin: { harness: "ClaudeCode", harnessVersion: "2.1.1" }, now: Date.now() });
    }
    const refusedStart = JSON.stringify({
      ...start,
      prompt: "start crew work",
      model: code === "ModelUnsupported" ? "unsupported-model" : start.model,
    });
    for (let attempt = 1; attempt <= 6; attempt++) {
      const before = world.tenantRowsWritten();
      const refused = await world.fetch(foremanTurn.member, "POST", "/v1/sessions", refusedStart);
      assert.equal(refused.status, 422);
      assert.equal(ProblemSchema.parse(await refused.json()).code, code);
      assert.equal(world.tenantRowsWritten() - before, attempt === 1 ? 11 : 3);
      assert.equal(count("StartRefused"), attempt);
      assert.equal(deliveries(), 1);
    }
    assert.equal(host.holds("TurnOffer"), false);

    await host.finishes(foremanTurn.offer);
    const wake = await takeTurn();
    const events = wake.offer.prompt.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(events.length, 1);
    const [eventText] = events;
    assert.ok(eventText);
    const refusal = StartRefusedEventSchema.parse(JSON.parse(eventText));
    assert.equal(refusal.refusal.code, code);
    assert.deepEqual(refusal.caller, { kind: "Turn", sessionId: foreman.sessionId, turnId: foremanTurn.offer.turnId });
    assert.deepEqual(refusal.crewTags, ["crew:x"]);
    assert.equal(counter(), 1);

    if (code === "HarnessNotInCatalog") await world.call("unpin", { harness: "ClaudeCode" });
    host.report({ memoryHeldMib: 0 });
    await world.settle();
    const sessionStarts = count("SessionStarted");
    const retryBefore = world.tenantRowsWritten();
    const retry = await world.fetch(
      wake.member,
      "POST",
      "/v1/sessions",
      JSON.stringify({ ...start, prompt: "start crew work" }),
    );
    assert.equal(retry.status, 200, await retry.clone().text());
    const { session: crew } = StartedSessionSchema.parse(await retry.json());
    assert.equal(world.tenantRowsWritten() - retryBefore, 32);
    assert.equal(count("SessionStarted") - sessionStarts, 1);
    assert.equal(count("CapacityAvailable"), 0);
    assert.equal(counter(), 0);
    const listed = await world.fetch(
      world.owner,
      "GET",
      `/v1/events?afterEventId=0&event=SessionStarted&sessionId=${crew.sessionId}`,
    );
    assert.equal(listed.status, 200);
    const page = z.object({ events: TenantEventSchema.array() }).parse(await listed.json());
    assert.deepEqual(
      page.events.map((event) => event.event === "SessionStarted" && event.caller),
      [{ kind: "Turn", sessionId: foreman.sessionId, turnId: wake.offer.turnId }],
    );
    assert.equal(host.takeOffer().sessionId, crew.sessionId);
  });
}
