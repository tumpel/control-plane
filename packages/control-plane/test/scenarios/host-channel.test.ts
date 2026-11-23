import assert from "node:assert/strict";
import { test } from "node:test";
import { CloseCode, PersonaSchema } from "@tumpel/schemas";
import { STORED_FRAMES_PROTOCOL } from "../../src/channel/protocol.ts";
import { request } from "./harness/server.ts";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { World } from "./harness/world.ts";

const SLOW_OFFER_MS = 500;

const received = (world: World, hostId: string): number =>
  Number(
    world.hostStorage(hostId).sql.exec("SELECT received FROM ledger WHERE ledger_id = 1").toArray()[0]?.received ?? 0,
  );

const turned = async (condition: () => boolean, what: string): Promise<void> => {
  for (let spin = 0; spin < 10_000; spin++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`${what} never happened`);
};

const RESULT = '{"type":"result","subtype":"success","is_error":false}';
const assistant = (n: number): string => `{"type":"assistant","n":${n}}`;

test("a tenant that restarts mid-turn keeps the host channel open, and the turn completes with every line once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write three lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: assistant(1) });
  host.report(DEFAULT_USAGE);
  await world.settle();
  await host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq: 2, text: assistant(2) });

  await world.restartTenant();
  host.report(DEFAULT_USAGE);
  await world.settle();
  assert.equal(host.closure(), null, "the tenant restart closed the host channel");
  await host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq: 3, text: RESULT });
  await host.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 3,
    completedAt: new Date(Date.now()).toISOString(),
  });
  await world.until(
    "a SnapshotRequest after the restart",
    () => host.received("SnapshotRequest").length,
    (requests) => requests > 0,
  );
  await host.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");
  assert.deepEqual(
    (await world.transcript(session.sessionId, {})).lines.map((line) => line.lineSeq),
    [1, 2, 3],
  );
});

test("a 37 host has each frame acked once stored, so a hibernation between heartbeats loses nothing and the next frame lands", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: STORED_FRAMES_PROTOCOL });
  const session = await world.startSession({ prompt: "write two lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.writes(offer.turnId, 1, [assistant(1)]);
  await world.settle();
  assert.deepEqual(host.unackedSeqs(), []);

  world.hibernateHostChannel(host.hostId);
  await host.writes(offer.turnId, 2, [RESULT]);
  await world.settle();
  assert.equal(host.closure(), null);
  assert.deepEqual(host.unackedSeqs(), []);
  assert.deepEqual(
    (await world.transcript(session.sessionId, {})).lines.map((line) => line.lineSeq),
    [1, 2],
  );
});

test("a host that reconnects with frames the control plane never acked resends them after Welcome, and they land in the transcript once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write two lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  host.report(DEFAULT_USAGE);
  await world.settle();
  const unacked = host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: assistant(1) });
  await world.settle();
  assert.deepEqual(host.unackedSeqs(), [unacked]);

  const reconnected = await world.reconnect(host);
  assert.equal((await host.closed()).code, CloseCode.Replaced);
  reconnected.report(DEFAULT_USAGE);
  await world.until(
    "the resent line stored",
    () => received(world, host.hostId),
    (seq) => seq >= unacked,
  );

  await reconnected.says({ type: "TurnLine", turnId: offer.turnId, lineSeq: 2, text: RESULT });
  await reconnected.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 2,
    completedAt: new Date(Date.now()).toISOString(),
  });
  await reconnected.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");
  assert.deepEqual(
    (await world.transcript(session.sessionId, {})).lines.map((line) => line.lineSeq),
    [1, 2],
  );
});

test("an offer that waits on the tenant while a heartbeat stores the held frames does not bring those frames back, so the next frame keeps the socket open", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "write lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  host.report(DEFAULT_USAGE);
  await world.settle();

  const { Tenant } = (await import(new URL("../../src/tenant.ts", import.meta.url).href)) as {
    Tenant: { prototype: Record<string, unknown> };
  };
  const inherited = Tenant.prototype.prepareOffer as (...args: unknown[]) => Promise<unknown>;
  let offerWaiting = false;
  Tenant.prototype.prepareOffer = async function (this: unknown, ...args: unknown[]) {
    offerWaiting = true;
    await new Promise((resolve) => setTimeout(resolve, SLOW_OFFER_MS));
    return inherited.apply(this, args);
  };
  t.after(() => {
    delete Tenant.prototype.prepareOffer;
  });

  const held = host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: assistant(1) });
  await world.settle();
  const personas = await world.fetch(world.owner, "GET", "/v1/personas");
  const [persona] = PersonaSchema.array().parse(await personas.json());
  assert.ok(persona);
  const starting = request(`${world.origin}/v1/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${world.owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      repository: "https://github.com/acme/app",
      model: "opus",
      personaId: persona.personaId,
      prompt: "a second session",
    }),
  });
  await turned(() => offerWaiting, "the second offer reaching the tenant");
  host.report(DEFAULT_USAGE);
  await turned(() => received(world, host.hostId) >= held, "the heartbeat storing the held line");
  await world.tick(SLOW_OFFER_MS);
  const started = await starting;
  assert.equal(started.status, 200, await started.clone().text());
  await world.settle();
  assert.equal(host.received("TurnOffer").length, 1);

  await host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq: 2, text: assistant(2) });
  assert.equal(host.closure(), null);
});
