import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { SETTINGS, World } from "./harness/world.ts";

const reasonOf = (turn: { state: string; reason?: string }): string | null =>
  turn.state === "Failed" ? (turn.reason ?? null) : null;

test("a host that closes its socket fails its running turn HostOffline at once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "stream a lot", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);

  await host.closesSocket();

  const turn = await world.turn(offer.turnId);
  assert.equal(reasonOf(turn), "HostOffline");
  assert.match(turn.state === "Failed" ? (turn.detail ?? "") : "", /went offline/);
});

test("a silent host counts as Degraded and takes no new session", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");

  host.quiet();
  await world.passes((SETTINGS.heartbeatDeadlineSeconds + 1) * 1000);

  const started = z
    .object({ started: z.object({ kind: z.literal("Unplaced"), hosts: z.array(z.object({ reason: z.string() })) }) })
    .parse(await world.tryStartSession({ prompt: "start while the host is silent", tags: [] }));
  assert.deepEqual(
    started.started.hosts.map((each) => each.reason),
    ["NotOnline"],
  );
  assert.equal(host.received("TurnOffer").length, 0);
});
