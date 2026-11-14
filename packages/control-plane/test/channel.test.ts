import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import * as control from "../src/channel/control.ts";
import * as host from "../src/channel/host.ts";
import {
  CloseCode,
  type ControlEnvelope,
  type ControlMessage,
  emptyLedger,
  type HostEnvelope,
  type HostMessage,
  type Ledger,
  type LedgerStore,
} from "../src/channel/protocol.ts";

const HOST_ID = "host-1";

const keyPair = (): { publicKey: string; sign: (bytes: Uint8Array) => Promise<string> } => {
  const pair = generateKeyPairSync("ed25519");
  const x = pair.publicKey.export({ format: "jwk" }).x ?? "";
  return {
    publicKey: Buffer.from(x, "base64url").toString("base64"),
    sign: async (bytes) => sign(null, bytes, pair.privateKey).toString("base64"),
  };
};

const memoryLedger = <M>(): LedgerStore<M> & { current: Ledger<M> } => {
  const store = {
    current: emptyLedger<M>(),
    load: () => store.current,
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

class Wire {
  toControl: string[] = [];
  toHost: string[] = [];
  closed: Closed | null = null;

  hostPort = {
    send: (envelope: HostEnvelope) => {
      if (this.closed === null) this.toControl.push(JSON.stringify(envelope));
    },
    close: (code: number, reason: string) => {
      this.closed ??= { code, reason };
    },
  };

  controlPort = {
    send: (envelope: ControlEnvelope) => {
      if (this.closed === null) this.toHost.push(JSON.stringify(envelope));
    },
    close: (code: number, reason: string) => {
      this.closed ??= { code, reason };
    },
  };
}

const closure = (wire: Wire): Closed | null => wire.closed;

const snapshotRequest = (snapshotId: string): ControlMessage => ({
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

const snapshotDone = (snapshotId: string): HostMessage => ({ type: "SnapshotDone", snapshotId, sizeBytes: 10 });

const setup = (revoked = false) => {
  const keys = keyPair();
  const controlLedger = memoryLedger<ControlMessage>();
  const hostLedger = memoryLedger<HostMessage>();
  const now = () => new Date("2026-11-14T10:00:00+00:00");
  const toHost: host.HostEvent[] = [];
  const toControl: control.ControlEvent[] = [];
  const peer = { hostId: HOST_ID, publicKey: keys.publicKey, revoked };

  const connect = () => {
    const wire = new Wire();
    const controlContext: control.ControlContext = {
      port: wire.controlPort,
      host: peer,
      ledger: controlLedger,
      now,
    };
    const hostContext: host.HostContext = {
      port: wire.hostPort,
      hostId: HOST_ID,
      supervisorVersion: "0.1.0",
      ledger: hostLedger,
      sign: keys.sign,
      now,
    };
    const link = {
      wire,
      controlContext,
      hostContext,
      control: control.challenge(wire.controlPort),
      host: host.connecting(),
      pump: async () => {
        while (wire.toControl.length > 0 || wire.toHost.length > 0) {
          const forHost = wire.toHost.shift();
          if (forHost !== undefined) {
            const received = await host.receive(link.host, forHost, hostContext);
            link.host = received.connection;
            if (received.event.kind !== "None") toHost.push(received.event);
          }
          const forControl = wire.toControl.shift();
          if (forControl !== undefined) {
            const received = await control.receive(link.control, forControl, controlContext);
            link.control = received.connection;
            if (received.event.kind !== "None") toControl.push(received.event);
          }
        }
      },
    };
    return link;
  };
  return { connect, toHost, toControl, controlLedger, hostLedger, peer };
};

test("the handshake signs the nonce, welcomes the host and carries frames both ways", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.pump();
  assert.equal(link.control.phase, "Open");
  assert.equal(link.host.phase, "Open");
  assert.deepEqual(channel.toHost, [{ kind: "Welcomed" }]);
  assert.deepEqual(channel.toControl, [{ kind: "Welcomed" }]);

  control.send(link.control, snapshotRequest("snap-1"), link.controlContext);
  host.send(link.host, snapshotDone("snap-1"), link.hostContext);
  await link.pump();
  assert.deepEqual(channel.toHost.at(-1), { kind: "Message", message: snapshotRequest("snap-1") });
  assert.deepEqual(channel.toControl.at(-1), { kind: "Message", message: snapshotDone("snap-1") });

  host.send(link.host, snapshotDone("snap-2"), link.hostContext);
  await link.pump();
  assert.deepEqual(channel.controlLedger.current.unacked, []);
  assert.equal(channel.controlLedger.current.received, 2);
  assert.equal(link.wire.closed, null);
});

test("a Hello signed by another key is closed as a bad signature", async () => {
  const channel = setup();
  const link = channel.connect();
  link.hostContext.sign = keyPair().sign;
  await link.pump();
  assert.equal(closure(link.wire)?.code, CloseCode.BadSignature);
  assert.equal(link.control.phase, "Closed");
});

test("a duplicate frame is dropped and a gap closes the connection", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.pump();
  host.send(link.host, snapshotDone("snap-1"), link.hostContext);
  const [frame] = link.wire.toControl;
  assert.ok(frame);
  link.wire.toControl.push(frame);
  await link.pump();
  assert.deepEqual(
    channel.toControl.filter((event) => event.kind === "Message"),
    [{ kind: "Message", message: snapshotDone("snap-1") }],
  );
  assert.equal(link.wire.closed, null);

  link.wire.toControl.push(JSON.stringify({ type: "Frame", seq: 5, ack: 0, message: snapshotDone("snap-5") }));
  await link.pump();
  assert.equal(closure(link.wire)?.code, CloseCode.ProtocolError);
  assert.match(closure(link.wire)?.reason ?? "", /expected seq 2, got 5/);
});

test("after a reconnect both sides resend unacked frames and each is delivered once", async () => {
  const channel = setup();
  const first = channel.connect();
  await first.pump();
  control.send(first.control, snapshotRequest("snap-1"), first.controlContext);
  host.send(first.host, snapshotDone("snap-1"), first.hostContext);
  await first.pump();
  first.wire.closed = { code: 1006, reason: "dropped" };

  control.send({ phase: "Closed" }, snapshotRequest("snap-2"), first.controlContext);
  host.send({ phase: "Closed" }, snapshotDone("snap-2"), first.hostContext);
  assert.equal(channel.controlLedger.current.unacked.length, 2);
  assert.equal(channel.hostLedger.current.unacked.length, 2);

  const second = channel.connect();
  await second.pump();
  const messages = (events: { kind: string }[]) => events.filter((event) => event.kind === "Message");
  assert.deepEqual(messages(channel.toHost), [
    { kind: "Message", message: snapshotRequest("snap-1") },
    { kind: "Message", message: snapshotRequest("snap-2") },
  ]);
  assert.deepEqual(messages(channel.toControl), [
    { kind: "Message", message: snapshotDone("snap-1") },
    { kind: "Message", message: snapshotDone("snap-2") },
  ]);
  assert.equal(second.wire.closed, null);
});

test("revoke closes a live connection and refuses a revoked host's next Hello", async () => {
  const channel = setup();
  const link = channel.connect();
  await link.pump();
  control.revoke(link.control, "retired", link.controlContext);
  await link.pump();
  assert.equal(closure(link.wire)?.code, CloseCode.Revoked);
  assert.deepEqual(channel.toHost.at(-1), { kind: "Revoked", reason: "retired" });

  channel.peer.revoked = true;
  const again = channel.connect();
  await again.pump();
  assert.equal(closure(again.wire)?.code, CloseCode.Revoked);
  assert.equal(channel.toControl.filter((event) => event.kind === "Welcomed").length, 1);
  assert.deepEqual(channel.toHost.at(-1), { kind: "Revoked", reason: "the tenant revoked this host" });
});
