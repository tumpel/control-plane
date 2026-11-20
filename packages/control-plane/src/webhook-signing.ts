import { base64Url } from "./crypto.ts";
import type { KeyStore } from "./key-store.ts";

const WEBHOOK_SIGNING_PURPOSE = "tumpel-webhook-v1";
const encoder = new TextEncoder();

const keyPair = (keyStore: KeyStore, tenantId: string) =>
  keyStore.ed25519KeyPair(`${WEBHOOK_SIGNING_PURPOSE}/${tenantId}`);

export const webhookPublicKey = async (keyStore: KeyStore, tenantId: string): Promise<string> =>
  base64Url((await keyPair(keyStore, tenantId)).publicKey);

export const signWebhook = async (keyStore: KeyStore, tenantId: string, body: string): Promise<string> => {
  const { privateKey } = await keyPair(keyStore, tenantId);
  return base64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(body))));
};
