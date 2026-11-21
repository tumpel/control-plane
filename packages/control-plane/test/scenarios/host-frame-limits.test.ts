import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { ChannelProtocol, CloseCode } from "@tumpel/schemas";
import * as control from "../../src/channel/control.ts";
import { HostFrameMeter, rateLimitDetail } from "../../src/channel/host-health.ts";
import {
  type ControlEnvelope,
  emptyLedger,
  type HostMessage,
  helloBytes,
  type Ledger,
  type StoredControlMessage,
} from "../../src/channel/protocol.ts";

const HOST_ID = "host-1";
const FRAMES_PER_MINUTE = 600;
const START = Date.parse("2026-11-21T11:00:00Z");

const savedTrips = () => {
  const saved = { trips: [] as number[] };
  const store = {
    save: (trips: number[]) => {
      saved.trips = [...trips];
    },
    clear: () => {
      saved.trips = [];
    },
  };
  return { saved, store };
};

const healthyMeter = () => new HostFrameMeter(FRAMES_PER_MINUTE, "Healthy", [], savedTrips().store);

const openChannel = async (meter: HostFrameMeter, protocolVersion: number = ChannelProtocol.Version) => {
  const clock = { now: START };
  const trips: string[] = [];
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x ?? "", "base64url").toString("base64");
  let ledger: Ledger<StoredControlMessage> = emptyLedger();
  const channel = {
    sent: [] as ControlEnvelope[],
    closed: null as string | null,
    connection: { phase: "Closed" } as control.ControlConnection,
    delivered: [] as number[],
  };
  const context: control.ControlContext = {
    port: {
      send: (envelope) => channel.sent.push(structuredClone(envelope)),
      close: (code, reason) => {
        channel.closed ??= `${code} ${reason}`;
      },
    },
    host: { hostId: HOST_ID, publicKey, revoked: false },
    ledger: {
      load: () => structuredClone(ledger),
      save: (next) => {
        ledger = structuredClone(next);
      },
      heard: () => ledger.received,
      skip: (frame) => {
        ledger = { ...ledger, received: frame.seq };
      },
      refused: () => new Set<number>(),
    },
    prepareOffer: async () => ({ kind: "Withdrawn" }),
    prepareClaudeSetup: async (stored) => ({
      kind: "Withdrawn",
      message: { type: "ClaudeSetupBoxDiscard", claudeSetupId: stored.claudeSetupId, boxId: stored.boxId },
    }),
    messageVersions: control.CONTROL_MESSAGE_VERSIONS,
    admitFrame: (seq) => {
      const admission = meter.admit(seq, clock.now);
      if (admission.kind === "Admitted") return null;
      if (admission.tripped !== null) {
        trips.push(admission.tripped);
        meter.settle(admission.tripped);
      }
      return {
        reason: rateLimitDetail(HOST_ID, admission.framesPerMinute),
        framesPerMinute: admission.framesPerMinute,
        retryAfter: new Date(admission.retryAfter),
      };
    },
    now: () => new Date(clock.now),
  };
  const receive = async (envelope: unknown) => {
    const received = await control.receive(channel.connection, JSON.stringify(envelope), context);
    channel.connection = received.connection;
    if (received.event.kind === "Message") {
      control.acknowledge(context, [received.event.frame]);
      channel.delivered.push(received.event.frame.seq);
    }
    return received.event;
  };
  channel.connection = control.challenge(context.port);
  const [challenge] = channel.sent;
  assert.equal(challenge?.type, "Challenge");
  await receive({
    type: "Hello",
    hostId: HOST_ID,
    protocolVersion,
    supervisorVersion: "0.1.0",
    signature: sign(null, helloBytes(challenge.nonce, HOST_ID), pair.privateKey).toString("base64"),
    boxCapacity: 8,
    usage: { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 4096 },
  });
  const frame = (seq: number, message: HostMessage) => receive({ type: "Frame", seq, ack: 0, message });
  const refusals = () =>
    channel.sent.flatMap((envelope) =>
      envelope.type === "FrameRefused" ? [`${envelope.seq}: ${envelope.reason}`] : [],
    );
  const rateLimited = () =>
    channel.sent.flatMap((envelope) => (envelope.type === "FrameRateLimited" ? [envelope] : []));
  return { channel, clock, trips, frame, refusals, rateLimited, received: () => ledger.received };
};

const snapshotDone = (snapshotId: string): HostMessage => ({ type: "SnapshotDone", snapshotId, uploadedBytes: 10 });

test("a host frame over the 4 MB bound is refused and the channel stays open for the next frame", async () => {
  const { channel, frame, refusals } = await openChannel(healthyMeter());

  const oversize = await frame(1, {
    type: "TurnLine",
    turnId: "turn-1",
    lineSeq: 1,
    text: "x".repeat(control.MAX_HOST_FRAME_BYTES),
  });
  await frame(2, snapshotDone("snap-2"));

  assert.equal(oversize.kind, "FrameRefused");
  assert.match(refusals()[0] ?? "", /^1: .*over the 4000000-byte bound/);
  assert.deepEqual(channel.delivered, [2]);
  assert.equal(channel.closed, null);
});

const turnLine = (lineSeq: number): HostMessage => ({ type: "TurnLine", turnId: "turn-1", lineSeq, text: "line" });
const stream = async (frame: (seq: number, message: HostMessage) => Promise<unknown>, from: number, count: number) => {
  for (let seq = from; seq < from + count; seq++) await frame(seq, turnLine(seq));
};

test("a host streaming 700 lines in a minute has the 100 past the limit refused with the limit and the next window, every one acked so none replays, and the channel stays open", async () => {
  const { channel, trips, frame, rateLimited, received } = await openChannel(healthyMeter());

  await stream(frame, 1, 700);

  assert.equal(channel.delivered.length, 600);
  const refused = rateLimited();
  assert.equal(refused.length, 100);
  assert.deepEqual(refused[0], {
    type: "FrameRateLimited",
    seq: 601,
    reason: `host ${HOST_ID} sent more than 600 frames a minute`,
    framesPerMinute: 600,
    retryAfter: "2026-11-21T11:01:00.000Z",
  });
  assert.equal(received(), 700);
  assert.deepEqual(trips, ["RateLimited"]);
  assert.equal(channel.closed, null);
});

test("a host under the limit has every frame delivered and stays Healthy", async () => {
  const meter = healthyMeter();
  const { channel, clock, trips, frame, rateLimited } = await openChannel(meter);

  await stream(frame, 1, 600);
  clock.now += 60_000;
  await stream(frame, 601, 600);

  assert.equal(channel.delivered.length, 1200);
  assert.deepEqual(rateLimited(), []);
  assert.deepEqual(trips, []);
  assert.equal(meter.health(), "Healthy");
});

test("a RateLimited host recovers after a full minute under the limit, and its next frames land", async () => {
  const meter = healthyMeter();
  const { channel, clock, frame } = await openChannel(meter);
  await stream(frame, 1, 700);

  clock.now += 60_000;
  assert.equal(meter.recovered(clock.now), false, "the minute after the trip is not yet a full clean window");
  await stream(frame, 701, 10);
  clock.now += 60_000;

  assert.equal(meter.recovered(clock.now), true);
  meter.settle("Healthy");
  assert.equal(meter.health(), "Healthy");
  await stream(frame, 711, 10);
  assert.equal(channel.delivered.length, 620);
});

test("a host tripping the limit a third time within an hour stays Unhealthy across an eviction until a person restores it, and the restore forgets its trips", async () => {
  const { saved, store } = savedTrips();
  const meter = new HostFrameMeter(FRAMES_PER_MINUTE, "Healthy", [], store);
  const { clock, trips, frame } = await openChannel(meter);
  let seq = 1;
  for (let trip = 0; trip < 3; trip++) {
    await stream(frame, seq, 601);
    seq += 601;
    clock.now += 2 * 60_000;
    if (meter.recovered(clock.now)) meter.settle("Healthy");
    clock.now += 10 * 60_000;
  }

  assert.deepEqual(trips, ["RateLimited", "RateLimited", "Unhealthy"]);
  assert.equal(saved.trips.length, 3);
  const evicted = new HostFrameMeter(FRAMES_PER_MINUTE, "Unhealthy", saved.trips, store);
  assert.equal(evicted.recovered(clock.now + 3_600_000), false);
  assert.equal(evicted.health(), "Unhealthy");
  evicted.restore();
  assert.equal(evicted.health(), "Healthy");
  assert.deepEqual(saved.trips, []);
});

test("a RateLimited host evicted mid-window still waits out the full clean window after its trip", async () => {
  const { saved, store } = savedTrips();
  const meter = new HostFrameMeter(FRAMES_PER_MINUTE, "Healthy", [], store);
  const { clock, frame } = await openChannel(meter);
  await stream(frame, 1, 601);

  const evicted = new HostFrameMeter(FRAMES_PER_MINUTE, "RateLimited", saved.trips, store);
  assert.equal(evicted.recovered(clock.now + 60_000), false);
  assert.equal(evicted.recovered(clock.now + 2 * 60_000), true);
});

test("frames the host replays after a reconnect are not counted twice against the limit", async () => {
  const meter = healthyMeter();
  for (let seq = 1; seq <= 400; seq++) assert.equal(meter.admit(seq, START).kind, "Admitted");
  for (let seq = 1; seq <= 400; seq++) assert.equal(meter.admit(seq, START).kind, "Admitted");
  for (let seq = 401; seq <= 600; seq++) assert.equal(meter.admit(seq, START).kind, "Admitted");
  assert.equal(meter.admit(601, START).kind, "Refused");
});

test("a trip changes the meter health only once the channel settles it, so a failed health write trips again", () => {
  const meter = healthyMeter();
  for (let seq = 1; seq <= 600; seq++) meter.admit(seq, START);
  const first = meter.admit(601, START);
  assert.equal(first.kind === "Refused" ? first.tripped : null, "RateLimited");
  assert.equal(meter.health(), "Healthy");
  for (let seq = 602; seq <= 1201; seq++) meter.admit(seq, START + 60_000);
  const second = meter.admit(1202, START + 60_000);
  assert.equal(second.kind === "Refused" ? second.tripped : null, "RateLimited");
  meter.settle("RateLimited");
  assert.equal(meter.health(), "RateLimited");
});

test("a host below protocol 32 over the limit is closed as an unsupported version with nothing stored, so it updates and replays the frame", async () => {
  const { channel, frame, rateLimited, received } = await openChannel(
    healthyMeter(),
    control.FRAME_RATE_LIMITED_VERSION - 1,
  );

  await stream(frame, 1, 601);

  assert.equal(channel.delivered.length, 600);
  assert.deepEqual(rateLimited(), []);
  assert.equal(received(), 600);
  assert.match(channel.closed ?? "", new RegExp(`^${CloseCode.UnsupportedVersion} over 600 frames a minute`));
});
