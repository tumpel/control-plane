import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { SETTINGS, World } from "./harness/world.ts";

const reasonOf = (turn: { state: string; reason?: string }): string | null =>
  turn.state === "Failed" ? (turn.reason ?? null) : null;

test("a running turn stays Running across a socket close and reconnect, and fails HostDropped on the first heartbeat that no longer holds it", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "keep running through a reconnect", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const rows = world.tenantRowsWritten();

  await host.closesSocket();
  assert.equal(world.tenantRowsWritten(), rows);
  assert.equal((await world.turn(offer.turnId)).state, "Running");

  const back = await world.reconnect(host);
  back.quiet();
  assert.equal((await world.turn(offer.turnId)).state, "Running");

  await back.beats({ heldTurnIds: [offer.turnId] });
  assert.equal((await world.turn(offer.turnId)).state, "Running");

  await back.beats({ heldTurnIds: [] });
  assert.equal(reasonOf(await world.turn(offer.turnId)), "HostDropped");
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
