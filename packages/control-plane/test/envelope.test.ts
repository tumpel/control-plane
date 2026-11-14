import assert from "node:assert/strict";
import { test } from "node:test";
import { importKeyEncryptionKey, newDataKey, seal, unseal, unwrapDataKey } from "../src/envelope.ts";

const keyOf = (fill: number): string => Buffer.alloc(32, fill).toString("base64");

test("a secret sealed under a wrapped data key opens again, and not under another key or context", async () => {
  const keyEncryptionKey = await importKeyEncryptionKey(keyOf(1));
  const wrapped = await newDataKey(keyEncryptionKey);
  const sealed = await seal(
    await unwrapDataKey(keyEncryptionKey, wrapped),
    "sk-ant-round-trip",
    "set-1/ANTHROPIC_API_KEY",
  );
  assert.ok(!sealed.includes("sk-ant-round-trip"));

  const reopened = await unwrapDataKey(await importKeyEncryptionKey(keyOf(1)), wrapped);
  assert.equal(await unseal(reopened, sealed, "set-1/ANTHROPIC_API_KEY"), "sk-ant-round-trip");

  await assert.rejects(
    unwrapDataKey(await importKeyEncryptionKey(keyOf(2)), wrapped),
    /does not unwrap with SECRETS_KEK/,
  );
  const otherDataKey = await unwrapDataKey(keyEncryptionKey, await newDataKey(keyEncryptionKey));
  await assert.rejects(unseal(otherDataKey, sealed, "set-1/ANTHROPIC_API_KEY"), /does not decrypt/);
  await assert.rejects(unseal(reopened, sealed, "set-2/ANTHROPIC_API_KEY"), /does not decrypt/);
});

test("a key-encryption key that is not 32 bytes is refused", async () => {
  await assert.rejects(importKeyEncryptionKey(undefined), /SECRETS_KEK is not 32 bytes/);
  await assert.rejects(importKeyEncryptionKey(Buffer.alloc(16).toString("base64")), /SECRETS_KEK is not 32 bytes/);
});
