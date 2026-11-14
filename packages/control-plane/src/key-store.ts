import { importKeyEncryptionKey, unwrapDataKey, wrapDataKey } from "./envelope.ts";
import type { Env } from "./index";

export interface KeyStore {
  wrap(dataKey: CryptoKey): Promise<string>;
  unwrap(wrapped: string): Promise<CryptoKey>;
}

export const workersSecretKeyStore = (secret: string | undefined): KeyStore => ({
  wrap: async (dataKey) => wrapDataKey(await importKeyEncryptionKey(secret), dataKey),
  unwrap: async (wrapped) => unwrapDataKey(await importKeyEncryptionKey(secret), wrapped),
});

export const keyStoreOf = (env: Env): KeyStore => workersSecretKeyStore(env.SECRETS_KEK);
