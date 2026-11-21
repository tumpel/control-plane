import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import * as control from "../../src/channel/control.ts";
import {
  type ControlEnvelope,
  emptyLedger,
  type HostMessage,
  helloBytes,
  type Ledger,
  type StoredControlMessage,
} from "../../src/channel/protocol.ts";
import { RateLimiter } from "./harness/runtime.ts";

const HOST_ID = "host-1";
const FRAMES_PER_MINUTE = 3;

const openChannel = async (rate: RateLimiter) => {
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
    },
    prepareOffer: async () => ({ kind: "Withdrawn" }),
    prepareClaudeSetup: async (stored) => ({
      kind: "Withdrawn",
      message: { type: "ClaudeSetupBoxDiscard", claudeSetupId: stored.claudeSetupId, boxId: stored.boxId },
    }),
    messageVersions: control.CONTROL_MESSAGE_VERSIONS,
    admitFrame: async () => {
      const { success } = await rate.limit({ key: HOST_ID });
      return success ? null : `host ${HOST_ID} sent more than ${FRAMES_PER_MINUTE} frames in a minute`;
    },
    now: () => new Date("2026-11-21T11:00:00Z"),
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
    protocolVersion: ChannelProtocol.Version,
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
  return { channel, frame, refusals };
};

const snapshotDone = (snapshotId: string): HostMessage => ({ type: "SnapshotDone", snapshotId, uploadedBytes: 10 });

test("a host frame over the 4 MB bound is refused and the channel stays open for the next frame", async () => {
  const { channel, frame, refusals } = await openChannel(new RateLimiter(100));

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
const telemetryBatch: HostMessage = {
  type: "TelemetryBatch",
  instruments: [{ metric: "host.load.1m", unit: "1", kind: "Sample", description: "one-minute load average" }],
  samples: [{ metric: "host.load.1m", at: "2026-11-17T10:00:00+01:00", value: 0.5, dimensions: {} }],
  turns: [],
};

test("a host sending telemetry past its per-minute rate has each extra batch refused, while its turn lines and outcome frames still land", async () => {
  const { channel, frame, refusals } = await openChannel(new RateLimiter(FRAMES_PER_MINUTE));

  for (const seq of [1, 2, 3, 4, 5]) await frame(seq, telemetryBatch);
  await frame(6, turnLine(1));
  await frame(7, snapshotDone("snap-7"));

  assert.deepEqual(channel.delivered, [1, 2, 3, 6, 7]);
  assert.deepEqual(refusals(), [
    `4: host ${HOST_ID} sent more than ${FRAMES_PER_MINUTE} frames in a minute`,
    `5: host ${HOST_ID} sent more than ${FRAMES_PER_MINUTE} frames in a minute`,
  ]);
  assert.equal(channel.closed, null);
});
