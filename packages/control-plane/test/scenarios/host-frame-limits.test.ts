import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import * as control from "../../src/channel/control.ts";
import { admit, openWindow, rateLimitDetail } from "../../src/channel/frame-rate.ts";
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

const openChannel = async () => {
  const clock = { now: START };
  let frames = openWindow(FRAMES_PER_MINUTE);
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
    },
    prepareOffer: async () => ({ kind: "Withdrawn" }),
    prepareClaudeSetup: async (stored) => ({
      kind: "Withdrawn",
      message: { type: "ClaudeSetupBoxDiscard", claudeSetupId: stored.claudeSetupId, boxId: stored.boxId },
    }),
    messageVersions: control.CONTROL_MESSAGE_VERSIONS,
    admitFrame: () => {
      const { window, refused } = admit(frames, clock.now);
      frames = window;
      if (refused === null) return null;
      return {
        reason: rateLimitDetail(HOST_ID, refused.framesPerMinute),
        framesPerMinute: refused.framesPerMinute,
        retryAfter: new Date(refused.retryAfter),
      };
    },
    now: () => new Date(clock.now),
  };
  const receive = async (envelope: unknown) => {
    const received = await control.receive(channel.connection, JSON.stringify(envelope), context);
    channel.connection = received.connection;
    if (received.event.kind === "Message" && channel.connection.phase === "Open") {
      channel.connection = control.acknowledge(channel.connection, received.event.frame.seq, context);
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
    protocolVersion: ChannelProtocol.Version,
    supervisorVersion: "0.1.0",
    signature: sign(null, helloBytes(challenge.nonce, HOST_ID), pair.privateKey).toString("base64"),
    boxCapacity: 8,
    heldTurnIds: [],
    resendFrom: 1,
    usage: {
      boxesWarm: 0,
      loadAverage: 0,
      memoryAvailableMib: 4096,
      memoryBudgetMib: 4096,
      memoryHeldMib: 0,
      diskBudgetMib: 100000,
      diskHeldMib: 0,
    },
  });
  const frame = (seq: number, message: HostMessage) => receive({ type: "Frame", seq, ack: 0, message });
  const refusals = () =>
    channel.sent.flatMap((envelope) =>
      envelope.type === "FrameRefused" ? [`${envelope.seq}: ${envelope.reason}`] : [],
    );
  const rateLimited = () =>
    channel.sent.flatMap((envelope) => (envelope.type === "FrameRateLimited" ? [envelope] : []));
  return { channel, clock, frame, refusals, rateLimited };
};

const snapshotDone = (snapshotId: string): HostMessage => ({
  type: "SnapshotDone",
  chunkCount: 1,
  snapshotId,
  uploadedBytes: 10,
});

test("a host frame over the 4 MB bound is refused and the channel stays open for the next frame", async () => {
  const { channel, frame, refusals } = await openChannel();

  const oversize = await frame(1, {
    type: "TurnLines",
    turnId: "turn-1",
    firstLineSeq: 1,
    lines: ["x".repeat(control.MAX_HOST_FRAME_BYTES)],
  });
  await frame(2, snapshotDone("snap-2"));

  assert.equal(oversize.kind, "FrameRefused");
  assert.match(refusals()[0] ?? "", /^1: .*over the 4000000-byte bound/);
  assert.deepEqual(channel.delivered, [2]);
  assert.equal(channel.closed, null);
});

const turnLines = (lineSeq: number): HostMessage => ({
  type: "TurnLines",
  turnId: "turn-1",
  firstLineSeq: lineSeq,
  lines: ["line"],
});
const stream = async (frame: (seq: number, message: HostMessage) => Promise<unknown>, from: number, count: number) => {
  for (let seq = from; seq < from + count; seq++) await frame(seq, turnLines(seq));
};

test("the frames past the limit are refused with the limit and the next window and stay unacked for the host to resend, and each lands once", async () => {
  const { channel, clock, frame, rateLimited } = await openChannel();
  for (let seq = 1; seq <= 610; seq++) await frame(seq, turnLines(seq));

  assert.equal(channel.delivered.length, 600);
  assert.deepEqual(
    rateLimited().map((limited) => limited.seq),
    [601, 602, 603, 604, 605, 606, 607, 608, 609, 610],
  );
  assert.deepEqual(rateLimited()[0], {
    type: "FrameRateLimited",
    seq: 601,
    reason: `host ${HOST_ID} sent more than 600 frames a minute`,
    framesPerMinute: 600,
    retryAfter: "2026-11-21T11:01:00.000Z",
  });
  clock.now += 60_000;
  for (let seq = 601; seq <= 610; seq++) await frame(seq, turnLines(seq));

  assert.deepEqual(
    channel.delivered,
    Array.from({ length: 610 }, (_, at) => at + 1),
  );
  assert.equal(channel.closed, null);
});

test("a host under the limit has every frame delivered", async () => {
  const { channel, clock, frame, rateLimited } = await openChannel();

  await stream(frame, 1, 600);
  clock.now += 60_000;
  await stream(frame, 601, 600);

  assert.equal(channel.delivered.length, 1200);
  assert.deepEqual(rateLimited(), []);
});
