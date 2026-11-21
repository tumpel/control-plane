import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { test } from "node:test";
import { ChannelProtocol, CloseCode } from "@tumpel/schemas";
import * as control from "../src/channel/control.ts";
import { refusedOrResent } from "../src/channel/failure.ts";
import {
  type ControlEnvelope,
  emptyLedger,
  HELD_SESSIONS_VERSION,
  type HostEnvelope,
  type HostMessage,
  helloBytes,
  type Ledger,
  type LedgerStore,
  type PreparedOffer,
  type StoredControlMessage,
} from "../src/channel/protocol.ts";

const HOST_ID = "host-1";
const USAGE = { boxesWarm: 1, loadAverage: 0.5, memoryAvailableMib: 4096 };

const keyPair = (): { publicKey: string; privateKey: KeyObject } => {
  const pair = generateKeyPairSync("ed25519");
  const x = pair.publicKey.export({ format: "jwk" }).x ?? "";
  return { publicKey: Buffer.from(x, "base64url").toString("base64"), privateKey: pair.privateKey };
};

const memoryLedger = <M>(): LedgerStore<M> & { current: Ledger<M> } => {
  const store = {
    current: emptyLedger<M>(),
    load: () => structuredClone(store.current),
    save: (ledger: Ledger<M>) => {
      store.current = structuredClone(ledger);
    },
  };
  return store;
};

interface Closed {
  code: number;
  reason: string;
}

const snapshotRequest = (snapshotId: string): StoredControlMessage => ({
  type: "SnapshotRequest",
  snapshotId,
  sessionId: "session-1",
  boxId: "box-1",
  turnId: "turn-1",
  snapshotSeq: 1,
  storageKey: `snapshots/${snapshotId}`,
  uploadUrl: "https://storage.example.test/upload",
  uploadExpiresAt: "2026-11-14T12:00:00+01:00",
});

const turnOffer: StoredControlMessage = {
  type: "TurnOffer",
  turnId: "turn-1",
  sessionId: "session-1",
  boxId: "box-1",
  repository: "https://git.example.test/repo.git",
  harness: "ClaudeCode",
  harnessVersion: "1.0.0",
  model: "claude-test",
  prompt: "hello",
};

const snapshotDone = (snapshotId: string): HostMessage => ({ type: "SnapshotDone", snapshotId, uploadedBytes: 10 });

const frame = (seq: number, ack: number, message: HostMessage): HostEnvelope => ({ type: "Frame", seq, ack, message });

const setup = (revoked = false, newer: Partial<control.MessageVersions> = {}) => {
  const messageVersions: control.MessageVersions = { ...control.CONTROL_MESSAGE_VERSIONS, ...newer };
  const keys = keyPair();
  const ledger = memoryLedger<StoredControlMessage>();
  const peer = { hostId: HOST_ID, publicKey: keys.publicKey, revoked };
  const turn = { offered: true };
  let minted = 0;
  const prepareOffer = async (): Promise<PreparedOffer> => {
    if (!turn.offered) return { kind: "Withdrawn" };
    minted += 1;
    return {
      kind: "Ready",
      turnTotalBudgetSeconds: 3600,
      credential: {
        credentialHandoverId: `grant-${minted}`,
        expiresAt: "2026-11-14T12:00:00+01:00",
        variables: [{ name: "API_KEY", value: `secret-${minted}` }],
        connectors: [],
      },
      lastLineSeq: 0,
      snapshots: [],
      personaFiles: [],
      image: {
        kind: "Full",
        imageDigest: "b".repeat(64),
        kernelDigest: "c".repeat(64),
        manifestDigest: "d".repeat(64),
        imageUrl: "https://r2.example.test/image",
        kernelUrl: "https://r2.example.test/kernel",
        manifestUrl: "https://r2.example.test/manifest",
        downloadExpiresAt: "2026-11-14T12:00:00+01:00",
        fetchSeconds: 900,
      },
      gitAuthorName: "Tumpel Agent",
      gitAuthorEmail: "agent@tumpel.invalid",
    };
  };

  const connect = () => {
    const sent: ControlEnvelope[] = [];
    const link = {
      sent,
      closed: null as Closed | null,
      events: [] as control.ControlEvent[],
      connection: { phase: "Closed" } as control.ControlConnection,
      context: {
        port: {
          send: (envelope: ControlEnvelope) => {
            if (link.closed === null) sent.push(structuredClone(envelope));
          },
          close: (code: number, reason: string) => {
            link.closed ??= { code, reason };
          },
        },
        host: peer,
        ledger,
        prepareOffer,
        prepareClaudeSetup: async (stored) => ({
          kind: "Withdrawn",
          message: { type: "ClaudeSetupBoxDiscard", claudeSetupId: stored.claudeSetupId, boxId: stored.boxId },
        }),
        messageVersions,
        now: () => new Date("2026-11-14T10:00:00+00:00"),
      } satisfies control.ControlContext,
      deliver: async (envelope: HostEnvelope) => {
        const received = await control.receive(link.connection, JSON.stringify(envelope), link.context);
        link.connection = received.connection;
        if (received.event.kind === "Message") control.acknowledge(link.context, received.event.frame);
        if (received.event.kind !== "None") link.events.push(received.event);
      },
      hello: async (privateKey: KeyObject = keys.privateKey, protocolVersion: number = ChannelProtocol.Version) => {
        const [challenge] = sent;
        assert.equal(challenge?.type, "Challenge");
        await link.deliver({
          type: "Hello",
          hostId: HOST_ID,
          protocolVersion,
          supervisorVersion: "0.1.0",
          signature: sign(null, helloBytes(challenge.nonce, HOST_ID), privateKey).toString("base64"),
          boxCapacity: 8,
          usage: USAGE,
        });
      },
      oldHello: async () => {
        const [challenge] = sent;
        assert.equal(challenge?.type, "Challenge");
        const hello = {
          type: "Hello",
          hostId: HOST_ID,
          protocolVersion: 1,
          supervisorVersion: "0.1.0",
          signature: sign(null, helloBytes(challenge.nonce, HOST_ID), keys.privateKey).toString("base64"),
        };
        const received = await control.receive(link.connection, JSON.stringify(hello), link.context);
        link.connection = received.connection;
      },
    };
    link.connection = control.challenge(link.context.port);
    return link;
  };
  return { connect, ledger, peer, turn };
};

const closure = (link: { closed: Closed | null }): Closed | null => link.closed;

const frames = (sent: ControlEnvelope[]) => sent.filter((envelope) => envelope.type === "Frame");

test("the handshake verifies the signed nonce, welcomes the host and carries frames both ways", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.hello();
  assert.equal(link.connection.phase, "Open");
  assert.deepEqual(link.events, [
    {
      kind: "Welcomed",
      boxCapacity: 8,
      usage: USAGE,
      supervisorVersion: "0.1.0",
      protocolVersion: ChannelProtocol.Version,
      channelProtocolOldest: undefined,
      guestProtocol: undefined,
    },
  ]);
  assert.deepEqual(
    link.sent.map((envelope) => envelope.type),
    ["Challenge", "Welcome"],
  );

  await control.send(link.connection, snapshotRequest("snap-1"), link.context);
  assert.deepEqual(frames(link.sent), [{ type: "Frame", seq: 1, ack: 0, message: snapshotRequest("snap-1") }]);
  await link.deliver(frame(1, 1, snapshotDone("snap-1")));
  assert.deepEqual(link.events.at(-1), { kind: "Message", frame: frame(1, 1, snapshotDone("snap-1")) });
  assert.deepEqual(channel.ledger.current, { received: 1, sent: 1, unacked: [] });
  assert.equal(link.closed, null);
});

test("a Hello on ChannelProtocol.Oldest is welcomed on that version", async () => {
  const link = setup().connect();
  await link.hello(undefined, ChannelProtocol.Oldest);
  assert.equal(link.connection.phase, "Open");
  assert.deepEqual(link.sent.at(-1), { type: "Welcome", hostId: HOST_ID, protocolVersion: ChannelProtocol.Oldest });
  assert.deepEqual(link.events.at(-1), {
    kind: "Welcomed",
    boxCapacity: 8,
    usage: USAGE,
    supervisorVersion: "0.1.0",
    protocolVersion: ChannelProtocol.Oldest,
    channelProtocolOldest: undefined,
    guestProtocol: undefined,
  });
});

test("a Hello on ChannelProtocol.Version is welcomed on that version", async () => {
  const link = setup().connect();
  await link.hello(undefined, ChannelProtocol.Version);
  assert.equal(link.connection.phase, "Open");
  assert.deepEqual(link.sent.at(-1), { type: "Welcome", hostId: HOST_ID, protocolVersion: ChannelProtocol.Version });
});

test("a Hello one below ChannelProtocol.Oldest is refused as an unsupported version", async () => {
  const link = setup().connect();
  await link.hello(undefined, ChannelProtocol.Oldest - 1);
  assert.equal(link.closed?.code, CloseCode.UnsupportedVersion);
  assert.equal(link.connection.phase, "Closed");
});

test("a Hello one above ChannelProtocol.Version is refused as an unsupported version", async () => {
  const link = setup().connect();
  await link.hello(undefined, ChannelProtocol.Version + 1);
  assert.equal(link.closed?.code, CloseCode.UnsupportedVersion);
  assert.equal(link.connection.phase, "Closed");
});

test("a Hello signed by another key is closed as a bad signature", async () => {
  const link = setup().connect();
  await link.hello(keyPair().privateKey);
  assert.equal(link.closed?.code, CloseCode.BadSignature);
  assert.equal(link.connection.phase, "Closed");
});

test("a Hello on protocol version 1, without the fields later versions added, is refused and the supervisor told to update", async () => {
  const link = setup().connect();
  await link.oldHello();
  assert.equal(link.closed?.code, CloseCode.UnsupportedVersion);
  assert.equal(
    link.closed?.reason,
    `protocol version 1 is not supported; this control plane speaks ${ChannelProtocol.Oldest} to ${ChannelProtocol.Version}, update the supervisor`,
  );
  assert.equal(link.connection.phase, "Closed");
});

test("a duplicate frame is dropped and a gap closes the connection", async () => {
  const link = setup().connect();
  await link.hello();
  await link.deliver(frame(1, 0, snapshotDone("snap-1")));
  await link.deliver(frame(1, 0, snapshotDone("snap-1")));
  assert.deepEqual(
    link.events.filter((event) => event.kind === "Message"),
    [{ kind: "Message", frame: frame(1, 0, snapshotDone("snap-1")) }],
  );
  assert.equal(link.closed, null);

  await link.deliver(frame(5, 0, snapshotDone("snap-5")));
  const closed = closure(link);
  assert.equal(closed?.code, CloseCode.ProtocolError);
  assert.match(closed?.reason ?? "", /expected seq 2, got 5/);
});

test("a frame whose message no schema reads is refused once in order, and the next frame follows it", async () => {
  const link = setup().connect();
  await link.hello();
  const unread = {
    type: "Frame",
    seq: 1,
    ack: 0,
    message: {
      type: "SupervisorUpdateStep",
      fromSha256: "a".repeat(64),
      toSha256: "b".repeat(64),
      phase: "Swapping",
      at: "2026-11-16T09:30:00+01:00",
    },
  };
  const deliverText = async (text: string) => {
    const received = await control.receive(link.connection, text, link.context);
    link.connection = received.connection;
    if (received.event.kind !== "None") link.events.push(received.event);
  };
  await deliverText(JSON.stringify(unread));
  await deliverText(JSON.stringify(unread));
  await link.deliver(frame(2, 0, snapshotDone("snap-2")));
  assert.equal(link.closed, null);
  const refusals = link.sent.filter((envelope) => envelope.type === "FrameRefused");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]?.type === "FrameRefused" && refusals[0].seq, 1);
  assert.match((refusals[0]?.type === "FrameRefused" && refusals[0].reason) || "", /message\.phase/);
  assert.deepEqual(
    link.events.slice(1).map((event) => event.kind),
    ["FrameRefused", "Message"],
  );

  await deliverText(JSON.stringify({ ...unread, seq: 4 }));
  const closed = closure(link);
  assert.equal(closed?.code, CloseCode.ProtocolError);
  assert.match(closed?.reason ?? "", /expected seq 3, got 4/);
});

test("a frame whose handling fails retryably stays unrecorded for the host to resend, and a deterministic failure refuses it", async () => {
  const link = setup().connect();
  await link.hello();
  const handle = async (envelope: HostEnvelope, error: unknown) => {
    const received = await control.receive(link.connection, JSON.stringify(envelope), link.context);
    link.connection = received.connection;
    if (received.event.kind !== "Message") return received.event.kind;
    const reply = refusedOrResent(received.event.frame.message.type, error);
    control.acknowledge(link.context, received.event.frame);
    control.refuseFrame(link.context.port, received.event.frame.seq, reply.reason);
    return reply.reason;
  };
  const retryable = Object.assign(new Error("Network connection lost."), { retryable: true });
  await assert.rejects(handle(frame(1, 0, snapshotDone("snap-1")), retryable), /Network connection lost/);
  const deterministic = new Error("string or blob too big: SQLITE_TOOBIG");
  assert.match(
    String(await handle(frame(1, 0, snapshotDone("snap-1")), deterministic)),
    /failed to handle SnapshotDone: string or blob too big/,
  );
  assert.equal(await handle(frame(1, 0, snapshotDone("snap-1")), deterministic), "None");
  await link.deliver(frame(2, 0, snapshotDone("snap-2")));
  assert.equal(link.closed, null);
  assert.equal(link.events.at(-1)?.kind, "Message");
});

test("a frame over the host frame bound is refused before it is read, and the next frame follows it", async () => {
  const link = setup().connect();
  await link.hello();
  const line: HostMessage = {
    type: "TurnLine",
    turnId: "turn-1",
    lineSeq: 1,
    text: "x".repeat(control.MAX_HOST_FRAME_BYTES),
  };
  const received = await control.receive(link.connection, JSON.stringify(frame(1, 0, line)), link.context);
  link.connection = received.connection;
  assert.equal(received.event.kind, "FrameRefused");
  await link.deliver(frame(2, 0, snapshotDone("snap-2")));
  assert.equal(link.closed, null);
  const refusals = link.sent.filter((envelope) => envelope.type === "FrameRefused");
  assert.equal(refusals[0]?.type === "FrameRefused" && refusals[0].seq, 1);
  assert.match((refusals[0]?.type === "FrameRefused" && refusals[0].reason) || "", /over the 4000000-byte bound/);
  assert.equal(link.events.at(-1)?.kind, "Message");
});

test("a frame and message carrying fields this control plane does not know are read for the fields it knows", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.hello();
  const extended = {
    type: "Frame" as const,
    seq: 1,
    ack: 0,
    priority: "High",
    message: { ...snapshotDone("snap-1"), compressedBytes: 7 },
  };
  await link.deliver(extended);
  assert.equal(link.closed, null);
  assert.deepEqual(link.events.at(-1), { kind: "Message", frame: frame(1, 0, snapshotDone("snap-1")) });
  assert.equal(channel.ledger.current.received, 1);
});

const telemetryBatch: HostMessage = {
  type: "TelemetryBatch",
  instruments: [{ metric: "host.load.1m", unit: "1", kind: "Sample", description: "one-minute load average" }],
  samples: [{ metric: "host.load.1m", at: "2026-11-17T10:00:00+01:00", value: 0.5, dimensions: {} }],
  turns: [],
};

test("a TelemetryBatch on a connection below its version is refused and acked, and the next frame follows it", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.hello(undefined, control.TELEMETRY_BATCH_VERSION - 1);
  await link.deliver(frame(1, 0, telemetryBatch));
  await link.deliver(frame(2, 0, snapshotDone("snap-2")));
  assert.equal(link.closed, null);
  assert.deepEqual(
    link.sent.filter((envelope) => envelope.type === "FrameRefused"),
    [
      {
        type: "FrameRefused",
        seq: 1,
        reason: `frame 1 carries TelemetryBatch, which needs protocol version ${control.TELEMETRY_BATCH_VERSION}; this connection speaks ${control.TELEMETRY_BATCH_VERSION - 1}, update the supervisor`,
      },
    ],
  );
  assert.deepEqual(
    link.events.slice(1).map((event) => event.kind),
    ["FrameRefused", "Message"],
  );
  assert.equal(channel.ledger.current.received, 2);
});

test("a TelemetryBatch on a connection that speaks its version is accepted as a message", async () => {
  const link = setup().connect();
  await link.hello(undefined, control.TELEMETRY_BATCH_VERSION);
  await link.deliver(frame(1, 0, telemetryBatch));
  assert.equal(link.closed, null);
  assert.deepEqual(link.events.at(-1), { kind: "Message", frame: frame(1, 0, telemetryBatch) });
});

test("after a reconnect the control plane resends unacked frames, each turn offer with a freshly minted grant", async () => {
  const channel = setup();
  const first = channel.connect();
  await first.hello();
  await control.send(first.connection, turnOffer, first.context);
  await first.deliver(frame(1, 0, snapshotDone("snap-1")));
  const [offered] = frames(first.sent);
  assert.equal(offered?.type === "Frame" && offered.message.type === "TurnOffer" && offered.seq, 1);
  first.closed = { code: 1006, reason: "dropped" };

  await control.send({ phase: "Closed" }, snapshotRequest("snap-2"), first.context);
  assert.equal(JSON.stringify(channel.ledger.current).includes("grant-"), false);
  assert.equal(JSON.stringify(channel.ledger.current).includes("secret-"), false);

  const second = channel.connect();
  await second.hello();
  const resent = frames(second.sent);
  assert.deepEqual(
    resent.map((envelope) => envelope.type === "Frame" && [envelope.seq, envelope.ack, envelope.message.type]),
    [
      [1, 1, "TurnOffer"],
      [2, 1, "SnapshotRequest"],
    ],
  );
  const [again] = resent;
  assert.ok(offered?.type === "Frame" && offered.message.type === "TurnOffer");
  assert.ok(again?.type === "Frame" && again.message.type === "TurnOffer");
  assert.equal(offered.message.credential.credentialHandoverId, "grant-1");
  assert.equal(again.message.credential.credentialHandoverId, "grant-2");
  assert.deepEqual({ ...again.message, credential: offered.message.credential }, offered.message);

  await second.deliver(frame(1, 0, snapshotDone("snap-1")));
  await second.deliver(frame(2, 2, snapshotDone("snap-2")));
  assert.deepEqual(
    [...first.events, ...second.events].filter((event) => event.kind === "Message"),
    [
      { kind: "Message", frame: frame(1, 0, snapshotDone("snap-1")) },
      { kind: "Message", frame: frame(2, 2, snapshotDone("snap-2")) },
    ],
  );
  assert.deepEqual(channel.ledger.current, { received: 2, sent: 2, unacked: [] });
  assert.equal(second.closed, null);
});

test("a frame whose handling failed stays unacknowledged, so its resend is handled again and the next frame waits for it", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.hello();
  const failed = await control.receive(
    link.connection,
    JSON.stringify(frame(1, 0, snapshotDone("snap-1"))),
    link.context,
  );
  assert.deepEqual(failed.event, { kind: "Message", frame: frame(1, 0, snapshotDone("snap-1")) });
  assert.equal(channel.ledger.current.received, 0);

  const resent = await control.receive(
    failed.connection,
    JSON.stringify(frame(1, 0, snapshotDone("snap-1"))),
    link.context,
  );
  assert.deepEqual(resent.event, { kind: "Message", frame: frame(1, 0, snapshotDone("snap-1")) });
  assert.ok(resent.event.kind === "Message");
  control.acknowledge(link.context, resent.event.frame);
  assert.equal(channel.ledger.current.received, 1);
  assert.equal(link.closed, null);
});

test("two sends never take the same seq, and a frame sent while an offer is prepared goes out ahead of it in seq order", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.hello();
  let release = (): void => undefined;
  const prepared = link.context.prepareOffer;
  link.context.prepareOffer = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return prepared();
  };
  const offering = control.send(link.connection, turnOffer, link.context);
  await control.send(link.connection, { type: "TurnClaimed", turnId: "turn-0" }, link.context);
  release();
  await offering;
  assert.deepEqual(
    frames(link.sent).map((envelope) => envelope.type === "Frame" && [envelope.seq, envelope.message.type]),
    [
      [1, "TurnClaimed"],
      [2, "TurnOffer"],
    ],
  );
});

test("a Hello below an unacked frame's version is closed as an unsupported version, and the frames stay for a newer one", async () => {
  const channel = setup(false, { TurnWithdrawn: ChannelProtocol.Version + 1 });
  const offline = channel.connect();
  await control.send({ phase: "Closed" }, snapshotRequest("snap-1"), offline.context);
  await control.send({ phase: "Closed" }, { type: "TurnWithdrawn", turnId: "turn-1" }, offline.context);

  const link = channel.connect();
  await link.hello();
  assert.deepEqual(link.closed, {
    code: CloseCode.UnsupportedVersion,
    reason: `frame 2 carries TurnWithdrawn, which needs protocol version ${ChannelProtocol.Version + 1}; this connection speaks ${ChannelProtocol.Version}, update the supervisor`,
  });
  assert.equal(link.connection.phase, "Closed");
  assert.deepEqual(frames(link.sent), []);
  assert.deepEqual(
    channel.ledger.current.unacked.map((unacked) => unacked.seq),
    [1, 2],
  );
});

test("a live frame newer than the connection's protocol version closes the connection as an unsupported version", async () => {
  const channel = setup(false, { TurnWithdrawn: ChannelProtocol.Version + 1 });
  const link = channel.connect();
  await link.hello();
  await control.send(link.connection, { type: "TurnWithdrawn", turnId: "turn-1" }, link.context);
  assert.equal(link.closed?.code, CloseCode.UnsupportedVersion);
  assert.deepEqual(frames(link.sent), []);
  assert.deepEqual(
    channel.ledger.current.unacked.map((unacked) => unacked.seq),
    [1],
  );
});

test("a turn that ended while its offer was unacked is resent as TurnWithdrawn, with no key", async () => {
  const channel = setup();
  const first = channel.connect();
  await first.hello();
  await control.send(first.connection, turnOffer, first.context);
  first.closed = { code: 1006, reason: "dropped" };
  channel.turn.offered = false;

  const second = channel.connect();
  await second.hello();
  const resent = frames(second.sent);
  assert.deepEqual(
    resent.map((envelope) => envelope.type === "Frame" && [envelope.seq, envelope.message]),
    [[1, { type: "TurnWithdrawn", turnId: "turn-1" }]],
  );
  assert.equal(JSON.stringify(second.sent).includes("secret-"), false);
});

test("revoke closes a live connection, and a revoked host's next Hello is closed before any frame", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.hello();
  await control.send({ phase: "Closed" }, snapshotRequest("snap-1"), link.context);
  control.revoke(link.context, "retired");
  assert.equal(link.closed?.code, CloseCode.Revoked);

  channel.peer.revoked = true;
  const before = structuredClone(channel.ledger.current);
  const again = channel.connect();
  await again.hello();
  assert.equal(again.closed?.code, CloseCode.Revoked);
  assert.deepEqual(
    again.sent.map((envelope) => envelope.type),
    ["Challenge"],
  );
  assert.deepEqual(channel.ledger.current, before);
});

test("only the first heartbeat after Welcome reports the held sessions, once per connection", async () => {
  const channel = setup();
  const first = channel.connect();
  await first.hello();
  const beat = (heldSessionIds: string[]): HostEnvelope => ({
    type: "Heartbeat",
    sentAt: "2026-11-18T10:00:00+01:00",
    usage: USAGE,
    heldSessionIds,
  });
  await first.deliver(beat(["session-1"]));
  await first.deliver(beat([]));
  assert.deepEqual(first.events.slice(1), [
    { kind: "FirstHeartbeat", usage: USAGE, heldSessionIds: ["session-1"] },
    { kind: "Heartbeat", usage: USAGE },
  ]);

  const second = channel.connect();
  await second.hello();
  await second.deliver(beat([]));
  assert.deepEqual(second.events.at(-1), { kind: "FirstHeartbeat", usage: USAGE, heldSessionIds: [] });
});

test("a heartbeat from a host before the held sessions version reports nothing", async () => {
  const link = setup().connect();
  await link.hello(undefined, HELD_SESSIONS_VERSION - 1);
  const heartbeat = { type: "Heartbeat", sentAt: "2026-11-18T10:00:00+01:00", usage: USAGE };
  const received = await control.receive(link.connection, JSON.stringify(heartbeat), link.context);
  assert.deepEqual(received.event, { kind: "Heartbeat", usage: USAGE });
  assert.equal(link.closed, null);
});
