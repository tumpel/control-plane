import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { test } from "node:test";
import { CloseCode } from "@tumpel/api/schemas";
import * as control from "../src/channel/control.ts";
import {
  type ControlEnvelope,
  type DispatchGrant,
  emptyLedger,
  type HostEnvelope,
  type HostMessage,
  helloBytes,
  type Ledger,
  type LedgerStore,
  type StoredControlMessage,
} from "../src/channel/protocol.ts";

const HOST_ID = "host-1";

const keyPair = (): { publicKey: string; privateKey: KeyObject } => {
  const pair = generateKeyPairSync("ed25519");
  const x = pair.publicKey.export({ format: "jwk" }).x ?? "";
  return { publicKey: Buffer.from(x, "base64url").toString("base64"), privateKey: pair.privateKey };
};

const memoryLedger = <M>(): LedgerStore<M> & { current: Ledger<M> } => {
  const store = {
    current: emptyLedger<M>(),
    load: async () => structuredClone(store.current),
    save: async (ledger: Ledger<M>) => {
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

const snapshotDone = (snapshotId: string): HostMessage => ({ type: "SnapshotDone", snapshotId, sizeBytes: 10 });

const frame = (seq: number, ack: number, message: HostMessage): HostEnvelope => ({ type: "Frame", seq, ack, message });

const setup = (revoked = false) => {
  const keys = keyPair();
  const ledger = memoryLedger<StoredControlMessage>();
  const peer = { hostId: HOST_ID, publicKey: keys.publicKey, revoked };
  let minted = 0;
  const mintGrant = async (): Promise<DispatchGrant> => {
    minted += 1;
    return {
      dispatchCredentialId: `grant-${minted}`,
      expiresAt: "2026-11-14T12:00:00+01:00",
      variables: [{ name: "API_KEY", value: `secret-${minted}` }],
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
        mintGrant,
        now: () => new Date("2026-11-14T10:00:00+00:00"),
      } satisfies control.ControlContext,
      deliver: async (envelope: HostEnvelope) => {
        const received = await control.receive(link.connection, JSON.stringify(envelope), link.context);
        link.connection = received.connection;
        if (received.event.kind !== "None") link.events.push(received.event);
      },
      hello: async (privateKey: KeyObject = keys.privateKey) => {
        const [challenge] = sent;
        assert.equal(challenge?.type, "Challenge");
        await link.deliver({
          type: "Hello",
          hostId: HOST_ID,
          protocolVersion: 1,
          supervisorVersion: "0.1.0",
          signature: sign(null, helloBytes(challenge.nonce, HOST_ID), privateKey).toString("base64"),
        });
      },
    };
    link.connection = control.challenge(link.context.port);
    return link;
  };
  return { connect, ledger, peer };
};

const closure = (link: { closed: Closed | null }): Closed | null => link.closed;

const frames = (sent: ControlEnvelope[]) => sent.filter((envelope) => envelope.type === "Frame");

test("the handshake verifies the signed nonce, welcomes the host and carries frames both ways", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.hello();
  assert.equal(link.connection.phase, "Open");
  assert.deepEqual(link.events, [{ kind: "Welcomed" }]);
  assert.deepEqual(
    link.sent.map((envelope) => envelope.type),
    ["Challenge", "Welcome"],
  );

  await control.send(link.connection, snapshotRequest("snap-1"), link.context);
  assert.deepEqual(frames(link.sent), [{ type: "Frame", seq: 1, ack: 0, message: snapshotRequest("snap-1") }]);
  await link.deliver(frame(1, 1, snapshotDone("snap-1")));
  assert.deepEqual(link.events.at(-1), { kind: "Message", message: snapshotDone("snap-1") });
  assert.deepEqual(channel.ledger.current, { received: 1, sent: 1, unacked: [] });
  assert.equal(link.closed, null);
});

test("a Hello signed by another key is closed as a bad signature", async () => {
  const link = setup().connect();
  await link.hello(keyPair().privateKey);
  assert.equal(link.closed?.code, CloseCode.BadSignature);
  assert.equal(link.connection.phase, "Closed");
});

test("a duplicate frame is dropped and a gap closes the connection", async () => {
  const link = setup().connect();
  await link.hello();
  await link.deliver(frame(1, 0, snapshotDone("snap-1")));
  await link.deliver(frame(1, 0, snapshotDone("snap-1")));
  assert.deepEqual(
    link.events.filter((event) => event.kind === "Message"),
    [{ kind: "Message", message: snapshotDone("snap-1") }],
  );
  assert.equal(link.closed, null);

  await link.deliver(frame(5, 0, snapshotDone("snap-5")));
  const closed = closure(link);
  assert.equal(closed?.code, CloseCode.ProtocolError);
  assert.match(closed?.reason ?? "", /expected seq 2, got 5/);
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
  assert.equal(offered.message.credential.dispatchCredentialId, "grant-1");
  assert.equal(again.message.credential.dispatchCredentialId, "grant-2");
  assert.deepEqual({ ...again.message, credential: offered.message.credential }, offered.message);

  await second.deliver(frame(1, 0, snapshotDone("snap-1")));
  await second.deliver(frame(2, 2, snapshotDone("snap-2")));
  assert.deepEqual(
    [...first.events, ...second.events].filter((event) => event.kind === "Message"),
    [
      { kind: "Message", message: snapshotDone("snap-1") },
      { kind: "Message", message: snapshotDone("snap-2") },
    ],
  );
  assert.deepEqual(channel.ledger.current, { received: 2, sent: 2, unacked: [] });
  assert.equal(second.closed, null);
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
