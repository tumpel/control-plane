import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { after, before, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PushSubscriptionSchema, TenantEventSchema, WebhookEndpointSchema } from "@tumpel/schemas";
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
const VAPID_JWK = createPrivateKey(RECEIVER_KEY).export({ format: "jwk" });
const VAPID_PUBLIC_KEY = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(VAPID_JWK.x ?? "", "base64url"),
  Buffer.from(VAPID_JWK.y ?? "", "base64url"),
]).toString("base64url");
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
const blockedResponses: { response: ServerResponse; status: number }[] = [];
const received: {
  body: string;
  eventId: string | undefined;
  signature: string | undefined;
  authorization: string | undefined;
  contentEncoding: string | undefined;
}[] = [];

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

const finishReceiver = (response: ServerResponse, status: number): void => {
  response.writeHead(status);
  response.end();
};

const releaseReceiver = (): void => {
  holdReceiver = false;
  for (const blocked of blockedResponses.splice(0)) finishReceiver(blocked.response, blocked.status);
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
      const status = request.url === "/push/retry" ? 500 : receiverStatus;
      received.push({
        body,
        eventId: Array.isArray(request.headers["tumpel-event-id"])
          ? request.headers["tumpel-event-id"][0]
          : request.headers["tumpel-event-id"],
        signature: Array.isArray(request.headers["tumpel-signature"])
          ? request.headers["tumpel-signature"][0]
          : request.headers["tumpel-signature"],
        authorization: request.headers.authorization,
        contentEncoding: Array.isArray(request.headers["content-encoding"])
          ? request.headers["content-encoding"][0]
          : request.headers["content-encoding"],
      });
      if (holdReceiver) blockedResponses.push({ response, status });
      else finishReceiver(response, status);
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
          vars: {
            ...config.vars,
            SECRETS_KEK: KEK,
            VAPID_PRIVATE_KEY: RECEIVER_KEY.toString(),
            VAPID_PUBLIC_KEY,
            VAPID_SUBJECT: "mailto:notifications@example.test",
          },
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

test("push delivery drops subscriptions the push service no longer knows", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const endpoint = `${receiverOrigin}/push/subscription`;
  const list = async (): Promise<number> => {
    const response = await post("/__fixture/push/list", { tenantId: TENANT_ID });
    return z
      .object({ result: z.object({ subscriptions: z.array(PushSubscriptionSchema) }) })
      .parse(await response.json()).result.subscriptions.length;
  };

  for (const [index, status] of [400, 404, 410].entries()) {
    const created = await post("/__fixture/push/create", {
      tenantId: TENANT_ID,
      subscription: {
        endpoint,
        keys: { p256dh, auth },
        events: ["SubscriptionPaused", "SubscriptionEnded"],
      },
      now: 6 + index * 2,
    });
    assert.equal(created.status, 200);
    assert.equal(await list(), 1);
    receiverStatus = status;
    const receivedBefore = received.length;
    await post("/__fixture/emit", {
      tenantId: TENANT_ID,
      event:
        status === 404
          ? {
              event: "SubscriptionPaused",
              subscriptionId: "subscription-4",
              sessionId: "session-4",
              reason: { kind: "ByRequest", message: "Choose a release." },
            }
          : {
              event: "SubscriptionEnded",
              subscriptionId: "subscription-4",
              sessionId: "session-4",
              reason: "GoalMet",
            },
      now: 7 + index * 2,
    });
    await post("/__fixture/push/alarm", { tenantId: TENANT_ID });
    await until(
      `the push service's HTTP ${status} response`,
      async () => ({ received: received.length, subscriptions: await list() }),
      (state) => state.received === receivedBefore + 1 && state.subscriptions === 0,
    );
    const delivery = received.at(-1);
    assert.equal(delivery?.contentEncoding, "aes128gcm");
    assert.match(delivery?.authorization ?? "", /^vapid t=.+, k=.+$/);
  }
  receiverStatus = 204;
});

test("a transient push failure leaves its wake without blocking another browser", async () => {
  const tenantId = crypto.randomUUID();
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  for (const path of ["retry", "success"]) {
    await post("/__fixture/push/create", {
      tenantId,
      subscription: {
        endpoint: `${receiverOrigin}/push/${path}`,
        keys: { p256dh, auth },
        events: ["SubscriptionPaused"],
      },
      now: 20,
    });
  }
  const receivedBefore = received.length;
  await post("/__fixture/emit", {
    tenantId,
    event: {
      event: "SubscriptionPaused",
      subscriptionId: "subscription-5",
      sessionId: "session-5",
      reason: { kind: "ByRequest", message: "Choose a release." },
    },
    now: 21,
  });
  await post("/__fixture/push/alarm", { tenantId });
  assert.ok(received.length >= receivedBefore + 2);
  const wakes = z
    .array(z.object({ push_subscription_id: z.string(), failures: z.int(), next_attempt_at: z.number() }))
    .parse(await (await post("/__fixture/push/wakes", { tenantId })).json());
  assert.equal(wakes.length, 1);
  assert.ok((wakes[0]?.failures ?? 0) >= 1);
  assert.ok((wakes[0]?.next_attempt_at ?? 0) > 21);
});

test("a terminal response keeps the wake when browser keys changed in flight", async () => {
  const tenantId = crypto.randomUUID();
  const firstPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const firstP256dh = Buffer.from(await crypto.subtle.exportKey("raw", firstPair.publicKey)).toString("base64url");
  const firstAuth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const endpoint = `${receiverOrigin}/push/replaced`;
  await post("/__fixture/push/create", {
    tenantId,
    subscription: {
      endpoint,
      keys: { p256dh: firstP256dh, auth: firstAuth },
      events: ["SubscriptionEnded"],
    },
    now: 30,
  });
  receiverStatus = 410;
  holdReceiver = true;
  const receivedBefore = received.length;
  await post("/__fixture/emit", {
    tenantId,
    event: {
      event: "SubscriptionEnded",
      subscriptionId: "subscription-6",
      sessionId: "session-6",
      reason: "GoalMet",
    },
    now: 31,
  });
  const alarm = post("/__fixture/push/alarm", { tenantId });
  await until(
    "the blocked push request",
    async () => received.length,
    (length) => length > receivedBefore,
  );
  const secondPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const secondP256dh = Buffer.from(await crypto.subtle.exportKey("raw", secondPair.publicKey)).toString("base64url");
  const secondAuth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  await post("/__fixture/push/create", {
    tenantId,
    subscription: {
      endpoint,
      keys: { p256dh: secondP256dh, auth: secondAuth },
      events: ["SubscriptionEnded"],
    },
    now: 32,
  });
  receiverStatus = 204;
  releaseReceiver();
  await alarm;
  await post("/__fixture/push/alarm", { tenantId });
  assert.ok(received.length >= receivedBefore + 2);
  const listed = z
    .object({ result: z.object({ subscriptions: z.array(PushSubscriptionSchema) }) })
    .parse(await (await post("/__fixture/push/list", { tenantId })).json());
  assert.equal(listed.result.subscriptions.length, 1);
});
