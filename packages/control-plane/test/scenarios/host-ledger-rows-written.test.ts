import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import * as control from "../../src/channel/control.ts";
import { HostLedger } from "../../src/channel/ledger.ts";
import { durableDb } from "../../src/db/client.ts";
import * as hostSchema from "../../src/db/host-schema.ts";
import { migratedDatabase, SqlStorage } from "./harness/runtime.ts";

const HOST_MIGRATIONS = new URL("../../migrations/host/", import.meta.url);

const channel = () => {
  const sql = new SqlStorage(migratedDatabase(HOST_MIGRATIONS));
  const ledger = new HostLedger(durableDb({ sql } as never, hostSchema));
  const closed: string[] = [];
  const sent: unknown[] = [];
  const context: control.ControlContext = {
    port: { send: (envelope) => sent.push(envelope), close: (code, reason) => closed.push(`${code}: ${reason}`) },
    host: { hostId: "host-1", publicKey: "key", revoked: false },
    ledger,
    prepareOffer: () => Promise.reject(new Error("this channel offers no turns")),
    prepareClaudeSetup: () => Promise.reject(new Error("this channel offers no Claude setup")),
    messageVersions: control.CONTROL_MESSAGE_VERSIONS,
    admitFrame: () => null,
    now: () => new Date(),
  };
  let connection: control.ControlConnection = { phase: "Open", protocolVersion: ChannelProtocol.Oldest, cursor: 0 };
  const lines = async (seq: number, text = `{"n":${seq}}`) => {
    const message = { type: "TurnLines", turnId: "turn-1", firstLineSeq: seq, lines: [text] };
    const received = await control.receive(
      connection,
      JSON.stringify({ type: "Frame", seq, ack: 0, message }),
      context,
    );
    connection = received.connection;
    if (received.event.kind === "Message" && connection.phase === "Open")
      connection = control.acknowledge(connection, seq, context);
    return received.event.kind;
  };
  return { sql, sent, closed, lines };
};

test("a connection writes no ledger row for the frames it stores and acks each one", async () => {
  const { sql, sent, lines } = channel();
  const start = sql.rowsWritten;
  for (let seq = 1; seq <= 500; seq++) assert.equal(await lines(seq), "Message");
  assert.equal(sql.rowsWritten - start, 0);
  assert.equal(sent.length, 500);
  assert.deepEqual(sent.at(-1), { type: "Ack", seq: 500 });
});

test("an oversized frame is refused and stepped over, so the next frame opens no gap", async () => {
  const { closed, lines } = channel();
  assert.equal(await lines(1), "Message");
  assert.equal(await lines(2, "x".repeat(control.MAX_HOST_FRAME_BYTES)), "FrameRefused");
  assert.equal(await lines(3), "Message");
  assert.deepEqual(closed, []);
});
