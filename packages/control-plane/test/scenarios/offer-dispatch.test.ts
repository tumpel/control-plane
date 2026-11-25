import assert from "node:assert/strict";
import { test } from "node:test";
import { installApp } from "./harness/github.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("an offered turn survives heartbeats while dispatch waits for a GitHub token", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await installApp(world.db, TENANT_ID, "acme");
  const host = await world.online(world.owner, "host-1");
  host.quiet();

  let releaseToken = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    releaseToken = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    world.github.beforeInstallationToken = () => {
      resolve();
      return held;
    };
  });
  const starting = world.startSession({ prompt: "wait for the GitHub token", tags: [] });
  await Promise.race([requested, starting]);
  const { turn_id: turnId } = world.tenantSql().exec<{ turn_id: string }>("SELECT turn_id FROM turns").one();

  try {
    for (let beat = 0; beat < 3; beat++) {
      await world.tick(world.settings.heartbeatIntervalSeconds * 1000);
      await host.beats({ heldTurnIds: [] });
      const turn = await world.turn(turnId);
      assert.equal(turn.state === "Failed" ? turn.reason : turn.state, "Offered");
    }
  } finally {
    releaseToken();
    await starting;
  }

  const offer = host.takeOffer();
  assert.equal(offer.turnId, turnId);
  await host.claims(offer);
  assert.equal((await world.turn(turnId)).state, "Running");
});
