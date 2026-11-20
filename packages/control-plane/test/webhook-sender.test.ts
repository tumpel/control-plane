import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TenantEventSchema, WebhookEndpointSchema } from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";
import { workersSecretKeyStore } from "../src/key-store.ts";
import { webhookPublicKey } from "../src/webhook-signing.ts";
import { until } from "./timing.ts";

type WorkerConfig = Extract<
  Extract<Parameters<typeof createTestHarness>[0], object>["workers"][number],
  { config: unknown }
>["config"];

const { env: _stages, ...config }: WorkerConfig & { env?: unknown } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8"),
);

const KEK = Buffer.alloc(32, 7).toString("base64");
const TENANT_ID = crypto.randomUUID();
const SenderStateSchema = z.object({
  tenantId: z.string(),
  webhookEndpointId: z.string(),
  cursorEventId: z.int(),
  failures: z.int(),
  failingSince: z.number().nullable(),
});
const EndpointResultSchema = z.object({ result: z.object({ endpoint: WebhookEndpointSchema.nullable() }) });

let receiver: Server;
let server: TestHarness;
let origin: string;
let receiverStatus = 204;
const received: { body: string; eventId: string | undefined; signature: string | undefined }[] = [];

const post = (path: string, body: unknown): ReturnType<TestHarness["fetch"]> =>
  server.fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
};

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

before(async () => {
  receiver = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        body,
        eventId: firstHeader(request.headers["tumpel-event-id"]),
        signature: firstHeader(request.headers["tumpel-signature"]),
      });
      response.writeHead(receiverStatus);
      response.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const receiverOrigin = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        config: {
          ...config,
          main: "./test/fixtures/webhook-worker.ts",
          vars: { ...config.vars, SECRETS_KEK: KEK, WEBHOOK_STUB_ORIGIN: receiverOrigin },
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
});

after(async () => {
  await server?.close();
  receiver?.close();
});

test("the sender signs ordered events, retries its cursor, fails after three days and stops on deletion", async () => {
  const created = await post("/__fixture/create", {
    tenantId: TENANT_ID,
    endpoint: {
      url: "https://receiver.example.test/hooks/events",
      events: ["SubscriptionPaused", "SubscriptionEnded"],
    },
    now: 1,
  });
  const endpoint = EndpointResultSchema.parse(await created.json()).result.endpoint;
  if (endpoint === null) throw new Error("the created webhook endpoint read back null");
  const senderPath = `/__fixture/sender/${TENANT_ID}/${endpoint.webhookEndpointId}`;

  await post("/__fixture/emit", {
    tenantId: TENANT_ID,
    event: {
      event: "SubscriptionPaused",
      subscriptionId: "subscription-1",
      sessionId: "session-1",
      reason: { kind: "ByRequest", message: "Which release should I use?" },
    },
    now: 2,
  });
  await post("/__fixture/emit", {
    tenantId: TENANT_ID,
    event: {
      event: "SubscriptionEnded",
      subscriptionId: "subscription-1",
      sessionId: "session-1",
      reason: "GoalMet",
    },
    now: 3,
  });
  await until(
    "two webhook events",
    async () => received.length,
    (length) => length === 2,
  );
  const events = received.map(({ body }) => TenantEventSchema.parse(JSON.parse(body)));
  assert.deepEqual(
    events.map((event) => event.eventId),
    [1, 2],
  );
  assert.deepEqual(events[0]?.event === "SubscriptionPaused" ? events[0].reason : null, {
    kind: "ByRequest",
    message: "Which release should I use?",
  });
  const publicKey = await webhookPublicKey(workersSecretKeyStore(KEK), TENANT_ID);
  const verifier = await crypto.subtle.importKey("raw", fromBase64Url(publicKey), "Ed25519", false, ["verify"]);
  for (const delivery of received) {
    assert.equal(delivery.eventId, String(TenantEventSchema.parse(JSON.parse(delivery.body)).eventId));
    assert.equal(
      await crypto.subtle.verify(
        "Ed25519",
        verifier,
        fromBase64Url(delivery.signature ?? ""),
        new TextEncoder().encode(delivery.body),
      ),
      true,
    );
  }

  receiverStatus = 500;
  const failedAt = Date.now();
  await post("/__fixture/emit", {
    tenantId: TENANT_ID,
    event: {
      event: "SubscriptionEnded",
      subscriptionId: "subscription-2",
      sessionId: "session-2",
      reason: "GoalMet",
    },
    now: 4,
  });
  await until(
    "the failed webhook attempt",
    async () => received.length,
    (length) => length === 3,
  );
  const failed = await server.fetch(`${origin}${senderPath}`);
  const firstFailure = z.object({ state: SenderStateSchema, alarmAt: z.number() }).parse(await failed.json());
  assert.equal(firstFailure.state.cursorEventId, 2);
  assert.equal(firstFailure.state.failures, 1);
  assert.ok(firstFailure.alarmAt >= failedAt + 59_000 && firstFailure.alarmAt <= Date.now() + 61_000);

  const failingSince = Date.now() - 3 * 24 * 60 * 60 * 1000;
  await post(`${senderPath}/fail-since`, { at: failingSince });
  await post(`${senderPath}/alarm`, {});
  assert.equal(received.length, 4);
  assert.equal(received[2]?.eventId, received[3]?.eventId);
  const read = await server.fetch(
    `${origin}/__fixture/endpoint?tenantId=${TENANT_ID}&webhookEndpointId=${endpoint.webhookEndpointId}`,
  );
  const failing = EndpointResultSchema.parse(await read.json()).result.endpoint;
  if (failing === null) throw new Error("the failing webhook endpoint read back null");
  assert.deepEqual(failing.status, {
    delivery: "Failing",
    detail: "HTTP 500",
    failingSince: new Date(failingSince).toISOString(),
  });

  const deleted = await post("/__fixture/delete", {
    tenantId: TENANT_ID,
    webhookEndpointId: endpoint.webhookEndpointId,
  });
  assert.deepEqual(await deleted.json(), { result: { deleted: true } });
  const stopped = z
    .object({ state: z.null(), alarmAt: z.null() })
    .parse(await (await server.fetch(`${origin}${senderPath}`)).json());
  assert.deepEqual(stopped, { state: null, alarmAt: null });
  receiverStatus = 204;
  await post("/__fixture/emit", {
    tenantId: TENANT_ID,
    event: {
      event: "SubscriptionEnded",
      subscriptionId: "subscription-3",
      sessionId: "session-3",
      reason: "GoalMet",
    },
    now: 5,
  });
  await wait(100);
  assert.equal(received.length, 4);
});
