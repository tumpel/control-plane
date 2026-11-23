import assert from "node:assert/strict";
import { test } from "node:test";
import * as control from "../../src/channel/control.ts";
import { HostLedger } from "../../src/channel/ledger.ts";
import { STORED_FRAMES_PROTOCOL } from "../../src/channel/protocol.ts";
import { durableDb } from "../../src/db/client.ts";
import * as hostSchema from "../../src/db/host-schema.ts";
import { migratedDatabase, SqlStorage } from "./harness/runtime.ts";

const HOST_MIGRATIONS = new URL("../../migrations/host/", import.meta.url);

const channel = (protocolVersion: number) => {
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
  let connection: control.ControlConnection = { phase: "Open", protocolVersion, cursor: 0 };
  const lines = async (seq: number, text = `{"n":${seq}}`) => {
    const message =
      protocolVersion >= STORED_FRAMES_PROTOCOL
        ? { type: "TurnLines", turnId: "turn-1", firstLineSeq: seq, lines: [text] }
        : { type: "TurnLine", turnId: "turn-1", lineSeq: seq, text };
    const received = await control.receive(
      connection,
      JSON.stringify({ type: "Frame", seq, ack: 0, message }),
      context,
    );
    connection = received.connection;
    if (received.event.kind === "Message" && connection.phase === "Open")
      connection = control.stored(connection, seq, context);
    return received.event.kind;
  };
  const checkpoint = () => control.checkpoint(connection, context);
  return { sql, ledger, sent, closed, lines, checkpoint };
};

test("a 37 connection writes no ledger row for the frames it stores and acks each one", async () => {
  const { sql, ledger, sent, lines, checkpoint } = channel(STORED_FRAMES_PROTOCOL);
  const start = sql.rowsWritten;
  for (let seq = 1; seq <= 500; seq++) assert.equal(await lines(seq), "Message");
  checkpoint();
  assert.equal(sql.rowsWritten - start, 0);
  assert.equal(ledger.load().received, 0);
  assert.equal(sent.length, 500);
  assert.deepEqual(sent.at(-1), { type: "Ack", seq: 500 });
});

test("a 36 connection writes one ledger row per heartbeat checkpoint that moved the cursor, and none for an idle one", async () => {
  const { sql, ledger, lines, checkpoint } = channel(STORED_FRAMES_PROTOCOL - 1);
  const start = sql.rowsWritten;
  for (let seq = 1; seq <= 500; seq++) await lines(seq);
  checkpoint();
  assert.equal(sql.rowsWritten - start, 1);
  assert.equal(ledger.load().received, 500);
  checkpoint();
  assert.equal(sql.rowsWritten - start, 1);
});

test("an oversized frame is refused and stepped over, so the next frame opens no gap", async () => {
  const { closed, lines } = channel(STORED_FRAMES_PROTOCOL);
  assert.equal(await lines(1), "Message");
  assert.equal(await lines(2, "x".repeat(control.MAX_HOST_FRAME_BYTES)), "FrameRefused");
  assert.equal(await lines(3), "Message");
  assert.deepEqual(closed, []);
});
