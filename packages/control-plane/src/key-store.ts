import {
  deriveEd25519KeyPair,
  deriveSigningKey,
  importKeyEncryptionKey,
  unwrapDataKey,
  wrapDataKey,
} from "./envelope.ts";

export interface KeyStore {
  wrap(dataKey: CryptoKey): Promise<string>;
  unwrap(wrapped: string): Promise<CryptoKey>;
  signingKey(purpose: string): Promise<CryptoKey>;
  ed25519KeyPair(purpose: string): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array<ArrayBuffer> }>;
}

export const workersSecretKeyStore = (secret: string | undefined): KeyStore => ({
  wrap: async (dataKey) => wrapDataKey(await importKeyEncryptionKey(secret), dataKey),
  unwrap: async (wrapped) => unwrapDataKey(await importKeyEncryptionKey(secret), wrapped),
  signingKey: (purpose) => deriveSigningKey(secret, purpose),
  ed25519KeyPair: (purpose) => deriveEd25519KeyPair(secret, purpose),
});

export const keyStoreOf = (env: { SECRETS_KEK?: string }): KeyStore => workersSecretKeyStore(env.SECRETS_KEK);
