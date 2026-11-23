import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol, ClaudeSetupSchema, HostSchema, SecretSetSchema, TurnSchema } from "@tumpel/schemas";
import { snapshotAsked } from "./harness/snapshot-chunks.ts";
import { type Host, SETTINGS, TENANT_ID, type TurnOffer, World } from "./harness/world.ts";

const GRACE_MS = SETTINGS.heartbeatDeadlineSeconds * 1000;

const reasonOf = (turn: { state: string; reason?: string }): string | null =>
  turn.state === "Failed" ? (turn.reason ?? null) : null;

const running = async (world: World, host: Host): Promise<TurnOffer> => {
  await world.startSession({ prompt: "run while the host reports", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  return offer;
};

const quietHost = async (
  world: World,
  options: { protocolVersion?: number; channelProtocolOldest?: number } = {},
): Promise<Host> => {
  await world.holdsAgentCredentials();
  const host = await world.online(world.owner, "host-1", options);
  host.quiet();
  return host;
};

const presence = async (world: World, hostId: string): Promise<string> => {
  const response = await world.fetch(world.owner, "GET", `/v1/hosts/${hostId}`);
  assert.equal(response.status, 200);
  return HostSchema.parse(await response.json()).presence;
};

test("a heartbeat that does not name a running turn fails it HostDropped", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  const offer = await running(world, host);

  await host.beats({ heldTurnIds: [] });

  assert.equal(reasonOf(await world.turn(offer.turnId)), "HostDropped");
});

test("a heartbeat that leaves out a finished turn whose snapshot is still in flight leaves it to the snapshot", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  const offer = await running(world, host);
  await host.completes(offer);

  await host.beats({ heldTurnIds: [], heldSessionIds: [offer.sessionId] });
  await host.answersSnapshot(offer.sessionId);

  assert.equal((await world.turn(offer.turnId)).state, "Completed");
});

test("an offered turn survives one heartbeat that does not name it and fails HostDropped on the second", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  await world.startSession({ prompt: "wait for the claim", tags: [] });
  const { turnId } = host.takeOffer();

  await host.beats({ heldTurnIds: [] });
  assert.equal((await world.turn(turnId)).state, "Offered");

  await host.beats({ heldTurnIds: [] });
  assert.equal(reasonOf(await world.turn(turnId)), "HostDropped");
});

test("a heartbeat that names an offered turn again resets its grace", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  await world.startSession({ prompt: "wait for the claim", tags: [] });
  const { turnId } = host.takeOffer();

  await host.beats({ heldTurnIds: [] });
  await host.beats({ heldTurnIds: [turnId] });
  await host.beats({ heldTurnIds: [] });

  assert.equal((await world.turn(turnId)).state, "Offered");
});

test("a heartbeat that does not name the session of a pending snapshot fails the snapshot and its turn SnapshotNotStored", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  const offer = await running(world, host);
  await host.completes(offer);
  host.take("SnapshotRequest");

  await host.beats({ heldTurnIds: [], heldSessionIds: [offer.sessionId] });
  assert.equal((await world.turn(offer.turnId)).state, "Running");

  await host.beats({ heldTurnIds: [], heldSessionIds: [] });
  assert.equal(reasonOf(await world.turn(offer.turnId)), "SnapshotNotStored");
});

test("a heartbeat that does not name a live Claude setup fails it", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  host.quiet();
  const created = await world.fetch(
    world.owner,
    "POST",
    "/v1/secret-sets",
    JSON.stringify({ name: "setup", secrets: [] }),
  );
  assert.equal(created.status, 200, await created.clone().text());
  const { secretSetId } = SecretSetSchema.parse(await created.json());
  const started = await world.fetch(world.owner, "POST", "/v1/claude-setups", JSON.stringify({ secretSetId }));
  assert.equal(started.status, 200, await started.clone().text());
  const { claudeSetupId } = ClaudeSetupSchema.parse(await started.json());
  host.take("ClaudeSetupBoxOffer");
  await host.says({
    type: "ClaudeSetupBoxUrl",
    claudeSetupId,
    signInUrl: "https://claude.ai/oauth/authorize?state=held",
  });
  const setup = async () => {
    const read = await world.fetch(world.owner, "GET", `/v1/claude-setups/${claudeSetupId}`);
    assert.equal(read.status, 200);
    return ClaudeSetupSchema.parse(await read.json()).status;
  };

  await host.beats({ heldClaudeSetupIds: [claudeSetupId] });
  assert.equal((await setup()).state, "AwaitingCode");

  await host.beats({ heldClaudeSetupIds: [] });
  const failed = await setup();
  assert.equal(failed.state === "Failed" ? failed.reason : failed.state, "NoHostOnline");
});

test("revoking a host fails its running turn HostRevoked", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  const offer = await running(world, host);

  const revoked = await world.fetch(world.owner, "POST", `/v1/hosts/${host.hostId}/revoke`, "{}");
  assert.equal(revoked.status, 200);

  assert.equal(reasonOf(await world.turn(offer.turnId)), "HostRevoked");
});

test("a Hello that does not name a running turn fails it HostDropped", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  const offer = await running(world, host);

  const back = await world.reconnect(host, { carried: { ...host.carried(), turns: [] } });
  back.quiet();

  assert.equal(reasonOf(await world.turn(offer.turnId)), "HostDropped");
});

test("a Hello that does not name a finished turn whose snapshot is pending fails the turn SnapshotNotStored for the client", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  const offer = await running(world, host);
  await host.completes(offer);
  const request = snapshotAsked(host, offer.sessionId);

  const back = await world.reconnect(host, { carried: { ...host.carried(), turns: [] } });
  back.quiet();

  const read = await world.fetch(world.owner, "GET", `/v1/turns/${offer.turnId}`);
  assert.equal(read.status, 200);
  const turn = TurnSchema.parse(await read.json());
  assert.equal(reasonOf(turn), "SnapshotNotStored");
  assert.ok(
    turn.state === "Failed" && turn.detail.includes("host host-1 connected again and no longer holds this turn"),
    JSON.stringify(turn),
  );
  const failures = world
    .tenantSql()
    .exec("SELECT reason FROM snapshot_failures WHERE snapshot_id = ?", request.snapshotId)
    .toArray()
    .map((row) => row.reason);
  assert.deepEqual(failures, ["NotAnswered"]);
  assert.equal((await world.session(offer.sessionId)).state, "Idle");
});

test("a Hello never fails an offered turn, however often it leaves the turn out", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  await world.startSession({ prompt: "wait for the claim", tags: [] });
  const { turnId } = host.takeOffer();

  const once = await world.reconnect(host, { carried: { ...host.carried(), turns: [] } });
  once.quiet();
  const twice = await world.reconnect(once, { carried: { ...once.carried(), turns: [] } });
  twice.quiet();

  assert.equal((await world.turn(turnId)).state, "Offered");
});

test(`a channel ${ChannelProtocol.Oldest} host connects and its heartbeats judge its turns`, async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world, {
    protocolVersion: ChannelProtocol.Oldest,
    channelProtocolOldest: ChannelProtocol.Oldest,
  });
  assert.equal(host.welcomedVersion(), ChannelProtocol.Oldest);
  const offer = await running(world, host);

  await host.beats();
  assert.equal((await world.turn(offer.turnId)).state, "Running");

  await host.beats({ heldTurnIds: [] });
  assert.equal(reasonOf(await world.turn(offer.turnId)), "HostDropped");
});

test(`a channel ${ChannelProtocol.Version} Hello is welcomed on ${ChannelProtocol.Version}, the newest this control plane speaks`, async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world, { protocolVersion: ChannelProtocol.Version });

  assert.equal(host.welcomedVersion(), ChannelProtocol.Version);
  await host.beats();
  assert.equal(host.closure(), null);
});

test("a host reads Online within the grace of its last report, Degraded after, and Offline once revoked", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  await host.beats();

  await world.passes(GRACE_MS - 1_000);
  assert.equal(await presence(world, host.hostId), "Online");

  await world.passes(2_000);
  assert.equal(await presence(world, host.hostId), "Degraded");

  await host.beats();
  assert.equal(await presence(world, host.hostId), "Online");

  const revoked = await world.fetch(world.owner, "POST", `/v1/hosts/${host.hostId}/revoke`, "{}");
  assert.equal(revoked.status, 200);
  assert.equal(await presence(world, host.hostId), "Offline");
});

test("a session and its running turn on a Degraded host read Unknown with no row written, and read Running again once it reports", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  const offer = await running(world, host);
  await host.beats({ heldTurnIds: [offer.turnId] });
  const rows = world.tenantRowsWritten();

  await world.passes(GRACE_MS + 1_000);

  const session = await world.session(offer.sessionId);
  assert.equal(session.state, "Unknown");
  assert.equal(session.lastTurn.state, "Unknown");
  assert.equal((await world.turn(offer.turnId)).state, "Unknown");
  assert.equal(world.tenantRowsWritten(), rows);

  await host.beats({ heldTurnIds: [offer.turnId] });
  assert.equal((await world.session(offer.sessionId)).state, "Running");
  assert.equal((await world.turn(offer.turnId)).state, "Running");
});

test("an idle heartbeat reads sessions and turns only through their indexes, however many sessions the tenant archived", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await quietHost(world);
  for (let at = 0; at < 3; at++) {
    const offer = await running(world, host);
    await host.finishes(offer);
    await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: offer.sessionId, now: Date.now() });
  }
  await host.beats({ heldTurnIds: [], heldSessionIds: [] });
  const sql = world.tenantSql();
  const exec = sql.exec.bind(sql);
  const ran: { query: string; params: unknown[] }[] = [];
  sql.exec = (query: string, ...params: unknown[]) => {
    ran.push({ query, params });
    return exec(query, ...params);
  };
  t.after(() => {
    sql.exec = exec;
  });

  await host.beats({ heldTurnIds: [], heldSessionIds: [] });

  const scans = ran.flatMap(({ query, params }) =>
    sql.db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(...(params as (string | number | null)[]))
      .map((row) => String(row.detail))
      .filter((detail) => /^SCAN (sessions|turns|s|t)\b/.test(detail) && !detail.includes(" USING "))
      .map((detail) => `${detail} in ${query}`),
  );
  assert.ok(ran.length > 0, "the heartbeat ran no tenant statement");
  assert.deepEqual(scans, []);
});
