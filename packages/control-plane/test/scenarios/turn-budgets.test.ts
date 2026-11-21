import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionSchema, TurnFailureSchema } from "@tumpel/schemas";
import { z } from "zod";
import { World } from "./harness/world.ts";

for (const override of [undefined, 10800]) {
  test(`a turn uses its ${override === undefined ? "persona" : "session"} budget beyond one hour and still times out`, async (t) => {
    const world = await World.open();
    t.after(() => world.close());
    const host = await world.hostOnline("host-1");
    const seed = await world.startSession({ prompt: "prepare the crew", tags: [] });
    const seedTurn = host.takeOffer();
    await host.claims(seedTurn);
    await host.finishes(seedTurn);

    await world.call("patchPersona", {
      tenantId: seed.tenantId,
      personaId: seed.personaId,
      patch: { turnTotalBudgetSeconds: 7200 },
      now: Date.now(),
    });

    const crew = await world.startSession({
      prompt: "work for several hours",
      tags: [],
      turnTotalBudgetSeconds: override,
    });
    const turn = host.takeOffer();
    await host.claims(turn);
    await host.says({ type: "TurnRepositoryReady", turnId: turn.turnId });
    await host.says({ type: "TurnLine", turnId: turn.turnId, lineSeq: 1, text: "working" });

    await world.passes(3601 * 1000);
    assert.equal((await world.turn(turn.turnId)).state, "Running");
    assert.equal((await world.session(seed.sessionId)).turnTotalBudgetSeconds, seed.turnTotalBudgetSeconds);
    const listed = z
      .object({ sessions: SessionSchema.array() })
      .parse(await world.call("listSessions", { tenantId: seed.tenantId, filter: {} }));
    assert.equal(
      listed.sessions.find((session) => session.sessionId === seed.sessionId)?.turnTotalBudgetSeconds,
      seed.turnTotalBudgetSeconds,
    );
    await world.call("patchPersona", {
      tenantId: crew.tenantId,
      personaId: crew.personaId,
      patch: { turnTotalBudgetSeconds: 14400 },
      now: Date.now(),
    });
    assert.equal((await world.session(crew.sessionId)).turnTotalBudgetSeconds, override ?? 7200);
    const budget = override ?? 7200;
    await world.passes((budget - 3602) * 1000);
    assert.equal((await world.turn(turn.turnId)).state, "Running");
    await world.passes(2000);
    assert.equal((await world.turn(turn.turnId)).state, "Failed");
    const { failure } = z
      .object({ failure: TurnFailureSchema })
      .parse(await world.call("getTurnFailure", { tenantId: crew.tenantId, turnId: turn.turnId }));
    assert.equal(failure.reason, "TurnTimedOut");
    assert.match(failure.detail, new RegExp(`within ${budget} seconds`));
  });
}
