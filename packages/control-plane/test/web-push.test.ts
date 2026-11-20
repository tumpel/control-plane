import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { encryptPushPayload, vapidAuthorization, vapidKey } from "../src/web-push.ts";

const decode = (value: string): Uint8Array<ArrayBuffer> => Buffer.from(value, "base64url");

test("Web Push encryption matches the RFC 8291 example", async () => {
  const senderPublic = decode(
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  );
  const sender = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(senderPublic.slice(1, 33)).toString("base64url"),
      y: Buffer.from(senderPublic.slice(33)).toString("base64url"),
      d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const body = await encryptPushPayload(
    new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    decode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    decode("BTBZMqHH6r4Tts7J_aSIgg"),
    decode("DGv6ra1nlYgDCS1FRnbzlw"),
    { privateKey: sender, publicKey },
  );
  assert.equal(
    Buffer.from(body).toString("base64url"),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

test("VAPID derives its public key and signs for the push service origin", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  assert.ok(publicJwk.x !== undefined && publicJwk.y !== undefined);
  const key = await vapidKey(pem);
  assert.equal(
    key.publicKey,
    Buffer.concat([Buffer.from([4]), decode(publicJwk.x), decode(publicJwk.y)]).toString("base64url"),
  );

  const now = 1_795_200_000_000;
  const authorization = await vapidAuthorization(
    "https://push.example.test/subscriptions/123",
    "https://api.example.test",
    key,
    now,
  );
  const matched = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(authorization);
  assert.ok(matched !== null);
  const [, header = "", claims = "", signature = "", publicKey = ""] = matched;
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    aud: "https://push.example.test",
    exp: now / 1000 + 86_400,
    sub: "https://api.example.test",
  });
  assert.equal(publicKey, key.publicKey);
  assert.equal(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
      decode(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    ),
    true,
  );
});
