import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { D1Database, DurableObjectState, migratedDatabase } from "./harness/runtime.ts";
import { BUDGETS, LIMITS, SETTINGS, TENANT_ID } from "./harness/world.ts";

type Channel = {
  register(hostId: string, publicKey: string): void;
  send(message: unknown): Promise<string>;
  webSocketMessage(socket: unknown, message: string): Promise<void>;
};

const { HostChannel } = (await import(new URL("../../src/host-channel.ts", import.meta.url).href)) as {
  HostChannel: new (ctx: never, env: never) => Channel;
};

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000, ...BUDGETS };

test("an offer that waits on the tenant while a heartbeat stores the held frames does not bring those frames back, so the next frame keeps the socket open", async () => {
  Object.defineProperty(WebSocket, "READY_STATE_OPEN", { value: WebSocket.OPEN });
  const db = new D1Database(migratedDatabase(new URL("../../migrations/", import.meta.url)));
  const now = Date.now();
  db.sql.exec(
    "INSERT INTO tenants (tenant_id, name, tier, created_at, updated_at) VALUES (?, ?, 'Configured', ?, ?)",
    TENANT_ID,
    TENANT_ID,
    now,
    now,
  );
  db.sql.exec(
    `INSERT INTO hosts (host_id, tenant_id, name, state, architecture, cpu_count, memory_bytes, public_key, supervisor_version, created_at, updated_at)
    VALUES ('host-1', ?, 'host-1', 'Online', 'Amd64', 8, ?, 'key', '0.1.0', ?, ?)`,
    TENANT_ID,
    32 * 1024 ** 3,
    now,
    now,
  );

  let offerReachedTenant = (): void => undefined;
  const offerWaiting = new Promise<void>((resolve) => {
    offerReachedTenant = resolve;
  });
  let answerOffer = (): void => undefined;
  const offerAnswered = new Promise<void>((resolve) => {
    answerOffer = resolve;
  });
  const results: Record<string, unknown> = {
    hostMessage: { reply: null },
    hostUsage: {},
    hostHello: {},
    hostPresence: {},
    prepareOffer: { prepared: { kind: "Withdrawn" } },
  };
  const tenant = {
    handle: async ({ operation }: { operation: string }) => {
      if (operation === "prepareOffer") {
        offerReachedTenant();
        await offerAnswered;
      }
      return { result: results[operation] };
    },
  };

  let attachment: unknown = {
    connection: { phase: "Open", protocolVersion: ChannelProtocol.Version, heldReported: true },
    lastReceivedAt: now,
    lastSentAt: now,
    report: { boxCapacity: 8, channelProtocol: ChannelProtocol.Version, usage: USAGE },
    heldFrom: null,
  };
  const closed: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    serializeAttachment: (value: unknown) => {
      attachment = structuredClone(value);
    },
    deserializeAttachment: () => structuredClone(attachment),
    send: () => undefined,
    close: (code: number, reason: string) => closed.push(`${code}: ${reason}`),
  };
  const ctx = Object.assign(new DurableObjectState("host-1"), { getWebSockets: () => [socket] });
  const env = { DB: db, TENANT: { getByName: () => tenant }, TUMPEL_SETTINGS: SETTINGS, TUMPEL_LIMITS: LIMITS };
  const channel = new HostChannel(ctx as never, env as never);
  await ctx.unblocked();
  channel.register("host-1", "key");

  const line = (seq: number) =>
    JSON.stringify({
      type: "Frame",
      seq,
      ack: 0,
      message: { type: "TurnLine", turnId: "turn-1", lineSeq: seq, text: `{"n":${seq}}` },
    });
  const heartbeat = JSON.stringify({
    type: "Heartbeat",
    sentAt: new Date().toISOString(),
    usage: USAGE,
    heldSessionIds: [],
    heldClaudeSetupIds: [],
  });

  await channel.webSocketMessage(socket, line(1));
  const offer = channel.send({ type: "TurnOffer", turnId: "turn-2" });
  await offerWaiting;
  await channel.webSocketMessage(socket, heartbeat);
  answerOffer();
  assert.equal(await offer, "Sent");
  await channel.webSocketMessage(socket, line(2));

  assert.deepEqual(closed, []);
});
