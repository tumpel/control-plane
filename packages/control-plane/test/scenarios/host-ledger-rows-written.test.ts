import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import * as control from "../../src/channel/control.ts";
import { HostLedger } from "../../src/channel/ledger.ts";
import { migratedDatabase, SqlStorage } from "./harness/runtime.ts";

const HOST_MIGRATIONS = new URL("../../migrations/host/", import.meta.url);

const channel = () => {
  const sql = new SqlStorage(migratedDatabase(HOST_MIGRATIONS));
  const ledger = new HostLedger(sql as never);
  const closed: string[] = [];
  const context: control.ControlContext = {
    port: { send: () => undefined, close: (code, reason) => closed.push(`${code}: ${reason}`) },
    host: { hostId: "host-1", publicKey: "key", revoked: false },
    ledger,
    prepareOffer: () => Promise.reject(new Error("this channel offers no turns")),
    prepareClaudeSetup: () => Promise.reject(new Error("this channel offers no Claude setup")),
    messageVersions: control.CONTROL_MESSAGE_VERSIONS,
    now: () => new Date(),
  };
  let connection: control.ControlConnection = {
    phase: "Open",
    protocolVersion: ChannelProtocol.Version,
    heldReported: true,
  };
  const line = async (seq: number) => {
    const text = JSON.stringify({
      type: "Frame",
      seq,
      ack: 0,
      message: { type: "TurnLine", turnId: "turn-1", lineSeq: seq, text: `{"n":${seq}}` },
    });
    const received = await control.receive(connection, text, context);
    connection = received.connection;
    if (received.event.kind === "Message") ledger.hold(received.event.frame, text.length);
    return received.event.kind;
  };
  return { sql, ledger, context, closed, line };
};

const rowsFor = async (lines: number) => {
  const { sql, ledger, context, line } = channel();
  const start = sql.totalRowsWritten();
  for (let seq = 1; seq <= lines; seq++) await line(seq);
  const held = sql.totalRowsWritten() - start;
  control.acknowledge(context, ledger.take());
  assert.equal(ledger.load().received, lines);
  return { held, checkpoint: sql.totalRowsWritten() - start };
};

test("the host channel writes no row per transcript line and one row per checkpoint, however many lines it holds", async () => {
  const one = await rowsFor(1);
  const many = await rowsFor(500);
  assert.equal(one.held, 0);
  assert.equal(many.held, 0);
  assert.equal(many.checkpoint, one.checkpoint);
  assert.equal(one.checkpoint, 1);
});

test("lines the channel lost before their checkpoint turn the next frame into a gap, so the host resends them", async () => {
  const { ledger, closed, line } = channel();
  for (let seq = 1; seq <= 3; seq++) assert.equal(await line(seq), "Message");
  ledger.take();
  assert.equal(await line(4), "Closed");
  assert.match(closed[0] ?? "", /frame gap: expected seq 1, got 4/);
});
