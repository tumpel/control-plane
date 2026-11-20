import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
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
const TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const RECEIVER_KEY = createPrivateKey({
  key: Buffer.from(
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgdynz+5rG3bU73ruz1aaUJ6vq/n1jHnb/F3d9QVAsRgShRANCAARkSovDgMmdATixB8GZXnwenNV027ar2Q8AIj6KGhltjm5RIJCjRD/7UHY+63wGm9XwjtokTEGcOArKIbbwOyfG",
    "base64",
  ),
  format: "der",
  type: "pkcs8",
}).export({ format: "pem", type: "pkcs8" });
const RECEIVER_CERT = `-----BEGIN CERTIFICATE-----
MIIBjzCCATSgAwIBAgIUfyIB1U7QagRkV1SL5Pxxb5ODdScwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEyMDIyMTU0OVoXDTM2MTExNzIy
MTU0OVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEZEqLw4DJnQE4sQfBmV58HpzVdNu2q9kPACI+ihoZbY5uUSCQo0Q/+1B2
Put8BpvV8I7aJExBnDgKyiG28DsnxqNkMGIwHQYDVR0OBBYEFOJU6bpwvvS3BKmW
IteX+/LaS3rJMB8GA1UdIwQYMBaAFOJU6bpwvvS3BKmWIteX+/LaS3rJMA8GA1Ud
EwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEfwAAATAKBggqhkjOPQQDAgNJADBGAiEA
icmobc7N6CfhV5Zoy5g7X1GcKv/IABtcO7f9330MS94CIQCmwmmPGX5nxtw6e7Yc
ZskS6IATrUKTfTeyDuTha9kNZQ==
-----END CERTIFICATE-----`;
const SenderStateSchema = z.object({
  tenantId: z.string(),
  webhookEndpointId: z.string(),
  cursorEventId: z.int(),
  generation: z.int(),
});
const FailureSchema = z.object({
  failures: z.int(),
  failingSince: z.number(),
});
const EndpointResultSchema = z.object({ result: z.object({ endpoint: WebhookEndpointSchema.nullable() }) });

let server: TestHarness;
let origin: string;
let receiverServer: Server | undefined;
let receiverOrigin: string;
let receiverStatus = 204;
let holdReceiver = false;
const blockedResponses: ServerResponse[] = [];
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

const finishReceiver = (response: ServerResponse): void => {
  response.writeHead(receiverStatus);
  response.end();
};

const releaseReceiver = (): void => {
  holdReceiver = false;
  for (const response of blockedResponses.splice(0)) finishReceiver(response);
};

before(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const localReceiver = createServer({ key: RECEIVER_KEY, cert: RECEIVER_CERT }, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        body,
        eventId: Array.isArray(request.headers["tumpel-event-id"])
          ? request.headers["tumpel-event-id"][0]
          : request.headers["tumpel-event-id"],
        signature: Array.isArray(request.headers["tumpel-signature"])
          ? request.headers["tumpel-signature"][0]
          : request.headers["tumpel-signature"],
      });
      if (holdReceiver) blockedResponses.push(response);
      else finishReceiver(response);
    });
  });
  receiverServer = localReceiver;
  await new Promise<void>((resolve) => localReceiver.listen(0, "127.0.0.1", resolve));
  const receiverAddress = localReceiver.address();
  if (receiverAddress === null || typeof receiverAddress === "string") {
    throw new Error("the webhook receiver did not listen on a TCP port");
  }
  receiverOrigin = `https://127.0.0.1:${receiverAddress.port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        config: {
          ...config,
          main: "./test/fixtures/webhook-worker.ts",
          vars: { ...config.vars, SECRETS_KEK: KEK },
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
});

after(async () => {
  await server?.close();
  if (receiverServer !== undefined) {
    await new Promise<void>((resolve, reject) =>
      receiverServer?.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
  if (TLS_REJECT_UNAUTHORIZED === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = TLS_REJECT_UNAUTHORIZED;
});

test("the sender signs ordered events, retries its cursor, fails after three days and stops on deletion", async () => {
  const created = await post("/__fixture/create", {
    tenantId: TENANT_ID,
    endpoint: {
      url: `${receiverOrigin}/hooks/events`,
      events: ["SubscriptionPaused", "SubscriptionEnded"],
    },
    now: 1,
  });
  const endpoint = EndpointResultSchema.parse(await created.json()).result.endpoint;
  if (endpoint === null) throw new Error("the created webhook endpoint read back null");
  const senderPath = `/__fixture/sender/${TENANT_ID}/${endpoint.webhookEndpointId}`;

  holdReceiver = true;
  const firstEmit = post("/__fixture/emit", {
    tenantId: TENANT_ID,
    event: {
      event: "SubscriptionPaused",
      subscriptionId: "subscription-1",
      sessionId: "session-1",
      reason: { kind: "ByRequest", message: "Which release should I use?" },
    },
    now: 2,
  });
  await until(
    "the blocked webhook event",
    async () => received.length,
    (length) => length === 1,
  );
  const secondEmit = post("/__fixture/emit", {
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
    "the concurrent sender wake",
    async () => {
      const snapshot = z
        .object({ state: SenderStateSchema.nullable() })
        .passthrough()
        .parse(await (await server.fetch(`${origin}${senderPath}`)).json());
      return snapshot.state?.generation ?? 0;
    },
    (generation) => generation === 2,
  );
  releaseReceiver();
  await Promise.all([firstEmit, secondEmit]);
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
  const firstFailure = z
    .object({ state: SenderStateSchema, failure: FailureSchema, alarmAt: z.number() })
    .parse(await failed.json());
  assert.equal(firstFailure.state.cursorEventId, 2);
  assert.equal(firstFailure.failure.failures, 1);
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
    .object({ state: z.null(), failure: z.null(), alarmAt: z.null() })
    .parse(await (await server.fetch(`${origin}${senderPath}`)).json());
  assert.deepEqual(stopped, { state: null, failure: null, alarmAt: null });
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
