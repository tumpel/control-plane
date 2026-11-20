import assert from "node:assert/strict";
import { test } from "node:test";
import { TenantEventSchema, WebhookSigningKeySchema } from "@tumpel/schemas";
import { workersSecretKeyStore } from "../src/key-store.ts";
import { webhookRetryDelay } from "../src/webhook-retry.ts";
import { signWebhook, webhookPublicKey } from "../src/webhook-signing.ts";

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
};

test("a tenant's public key verifies its webhook signature", async () => {
  const keyStore = workersSecretKeyStore(Buffer.alloc(32, 7).toString("base64"));
  const body = JSON.stringify(
    TenantEventSchema.parse({
      event: "SubscriptionPaused",
      eventId: 42,
      tenantId: "tenant-1",
      subscriptionId: "subscription-1",
      sessionId: "session-1",
      reason: { kind: "ByRequest", message: "Which release should I use?" },
      createdAt: 123,
    }),
  );
  const publicKey = await webhookPublicKey(keyStore, "tenant-1");
  const signature = await signWebhook(keyStore, "tenant-1", body);
  WebhookSigningKeySchema.parse({ algorithm: "Ed25519", publicKey });
  const verifier = await crypto.subtle.importKey("raw", fromBase64Url(publicKey), "Ed25519", false, ["verify"]);
  assert.equal(
    await crypto.subtle.verify("Ed25519", verifier, fromBase64Url(signature), new TextEncoder().encode(body)),
    true,
  );
  assert.notEqual(await webhookPublicKey(keyStore, "tenant-2"), publicKey);
});

test("webhook retries double from one minute and stop growing at one hour", () => {
  assert.deepEqual(
    [1, 2, 3, 7, 8, 20].map(webhookRetryDelay),
    [60_000, 120_000, 240_000, 3_600_000, 3_600_000, 3_600_000],
  );
});
