import assert from "node:assert/strict";
import { test } from "node:test";
import { ListEventsResultSchema, PersonaSchema, ProblemSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { TENANT_ID, World } from "./harness/world.ts";

for (const caller of ["start", "start-from-issue", "send", "preflight"]) {
  test(`StartRefused coalesces ${caller} refusals and delivers the answered problem once`, async (t) => {
    const world = await World.open();
    t.after(() => world.close());
    const host = await world.online(world.owner, "host-1", {
      boxCapacity: 1,
      usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
    });
    let targetSessionId = "";
    if (caller === "send") {
      const target = await world.startSession({ prompt: "crew work", tags: ["crew:work"] });
      const turn = host.takeOffer();
      await host.claims(turn);
      await host.finishes(turn);
      await host.dropsIdleBox(turn);
      targetSessionId = target.sessionId;
    }
    const foreman = await world.startSession({ prompt: "lead the crew", tags: ["role:foreman"] });
    const enabled = await world.fetch(
      world.owner,
      "PATCH",
      `/v1/personas/${foreman.personaId}`,
      JSON.stringify({ tumpelMcp: true }),
    );
    assert.equal(enabled.status, 200);
    const persona = PersonaSchema.parse(await enabled.json());
    if (caller === "start-from-issue") {
      await world.call("setSecretMember", {
        tenantId: TENANT_ID,
        secretSetId: persona.secretSetId,
        member: { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-e2e-scenario" },
        githubUser: { githubUserId: 1, login: "scenario" },
        now: Date.now(),
      });
    }
    await world.subscribe(foreman, {
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
    const member = { tenantId: TENANT_ID, token: served.token.accessToken };
    const path =
      caller === "send"
        ? `/v1/sessions/${targetSessionId}/turns`
        : caller === "start-from-issue"
          ? "/v1/sessions/from-issue"
          : "/v1/sessions";
    const body =
      caller === "send"
        ? { prompt: "do crew work" }
        : caller === "start-from-issue"
          ? { personaId: foreman.personaId, owner: "acme", name: "app", issueNumber: 12, model: "opus" }
          : {
              personaId: foreman.personaId,
              repository: "https://github.com/acme/app",
              model: caller === "preflight" ? "unsupported-model" : "opus",
              prompt: "do crew work",
            };
    const before = world.tenantRowsWritten();
    const response = await world.fetch(member, "POST", path, JSON.stringify(body));
    assert.equal(response.status, caller === "preflight" ? 422 : 409);
    const problem = ProblemSchema.parse(await response.json());
    assert.equal(problem.code, caller === "preflight" ? "ModelUnsupported" : "PoolExhausted");
    assert.equal(world.tenantRowsWritten() - before, 13);
    const afterFirst = world.tenantRowsWritten();
    for (let attempt = 0; attempt < 5; attempt++) {
      const repeated = await world.fetch(member, "POST", path, JSON.stringify(body));
      assert.equal(repeated.status, response.status);
      assert.deepEqual(ProblemSchema.parse(await repeated.json()), problem);
    }
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
    assert.deepEqual(event.refusal, { code: problem.code, detail: problem.detail });
    assert.equal(event.operation, caller === "send" ? "Send" : "Start");
    assert.equal(event.personaId, foreman.personaId);
    assert.equal(event.model, caller === "preflight" ? "unsupported-model" : "opus");
    assert.deepEqual(event.crewTags, ["crew:work"]);
    assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 1);

    await host.finishes(offer);
    const delivery = host.takeOffer();
    assert.equal(delivery.sessionId, foreman.sessionId);
    assert.match(delivery.prompt, /StartRefused/);
    assert.ok(delivery.prompt.includes(problem.code));
    assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
    await host.claims(delivery);
    await host.finishes(delivery);
    assert.equal(host.holds("TurnOffer"), false);
  });
}
