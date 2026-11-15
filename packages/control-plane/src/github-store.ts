import type { GitHubInstallationSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { generateDataKey, seal, unseal } from "./envelope.ts";
import {
  type AppKey,
  type GitHubAppConversion,
  type GitHubInstallationRecord,
  importAppKey,
  type OAuthClient,
  pkcs8FromPem,
} from "./github.ts";
import type { KeyStore } from "./key-store.ts";

export type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>;

export interface StoredApp {
  appId: number;
  slug: string;
  ownerLogin: string;
  htmlUrl: string;
}

type AppRow = {
  app_id: number;
  slug: string;
  client_id: string;
  owner_login: string;
  html_url: string;
  wrapped_data_key: string;
  client_secret_sealed: string;
  webhook_secret_sealed: string;
  private_key_sealed: string;
};

const RESEAL_APP =
  "SECRETS_KEK no longer opens the stored GitHub App; restore the key it was sealed with, or delete the row of github_apps in D1 and create the App again at /github/app/setup";

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const appRow = (db: D1Database): Promise<AppRow | null> =>
  db
    .prepare(
      "SELECT app_id, slug, client_id, owner_login, html_url, wrapped_data_key, client_secret_sealed, webhook_secret_sealed, private_key_sealed FROM github_apps WHERE github_app_slot = 1",
    )
    .first<AppRow>();

export const storedApp = async (db: D1Database): Promise<StoredApp | null> => {
  const row = await appRow(db);
  return row === null
    ? null
    : { appId: row.app_id, slug: row.slug, ownerLogin: row.owner_login, htmlUrl: row.html_url };
};

const unsealed = async (
  keyStore: KeyStore,
  row: AppRow,
  sealed: "client_secret_sealed" | "webhook_secret_sealed" | "private_key_sealed",
  context: string,
): Promise<string> => unseal(await keyStore.unwrap(row.wrapped_data_key), row[sealed], context, RESEAL_APP);

export const appKey = async (db: D1Database, keyStore: KeyStore): Promise<AppKey | null> => {
  const row = await appRow(db);
  if (row === null) return null;
  const pkcs8 = await unsealed(keyStore, row, "private_key_sealed", "github-app/private_key");
  return { clientId: row.client_id, privateKey: await importAppKey(fromBase64(pkcs8)) };
};

export const oauthClient = async (db: D1Database, keyStore: KeyStore): Promise<OAuthClient | null> => {
  const row = await appRow(db);
  if (row === null) return null;
  return {
    clientId: row.client_id,
    clientSecret: await unsealed(keyStore, row, "client_secret_sealed", "github-app/client_secret"),
  };
};

export const webhookSecret = async (db: D1Database, keyStore: KeyStore): Promise<string | null> => {
  const row = await appRow(db);
  return row === null ? null : unsealed(keyStore, row, "webhook_secret_sealed", "github-app/webhook_secret");
};

export type AppStored = { kind: "Stored"; app: StoredApp } | { kind: "Exists"; app: StoredApp };

export const storeApp = async (
  db: D1Database,
  keyStore: KeyStore,
  conversion: GitHubAppConversion,
  now: number,
): Promise<AppStored> => {
  const pkcs8 = pkcs8FromPem(conversion.pem);
  await importAppKey(pkcs8);
  const dataKey = await generateDataKey();
  const result = await db
    .prepare(
      `INSERT INTO github_apps (github_app_slot, app_id, slug, client_id, owner_login, html_url, wrapped_data_key,
        client_secret_sealed, webhook_secret_sealed, private_key_sealed, created_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (github_app_slot) DO NOTHING`,
    )
    .bind(
      conversion.id,
      conversion.slug,
      conversion.client_id,
      conversion.owner.login,
      conversion.html_url,
      await keyStore.wrap(dataKey),
      await seal(dataKey, conversion.client_secret, "github-app/client_secret"),
      await seal(dataKey, conversion.webhook_secret, "github-app/webhook_secret"),
      await seal(dataKey, toBase64(pkcs8), "github-app/private_key"),
      now,
    )
    .run();
  const app = await storedApp(db);
  if (app === null) throw new Error("github_apps holds no App right after the insert; check the D1 migrations");
  return result.meta.changes === 1 ? { kind: "Stored", app } : { kind: "Exists", app };
};

type InstallationRow = { installation_id: number; tenant_id: string; account_login: string; created_at: number };

const toInstallation = (row: InstallationRow): GitHubInstallation => ({
  installationId: row.installation_id,
  tenantId: row.tenant_id,
  accountLogin: row.account_login,
  createdAt: row.created_at,
});

export const installationOf = async (db: D1Database, tenantId: string): Promise<GitHubInstallation | null> => {
  const row = await db
    .prepare(
      "SELECT installation_id, tenant_id, account_login, created_at FROM github_installations WHERE tenant_id = ?",
    )
    .bind(tenantId)
    .first<InstallationRow>();
  return row === null ? null : toInstallation(row);
};

export type Linked = { kind: "Linked"; installation: GitHubInstallation } | { kind: "OtherTenant" };

export const linkInstallation = async (
  db: D1Database,
  tenantId: string,
  record: GitHubInstallationRecord,
  now: number,
): Promise<Linked> => {
  const owner = await db
    .prepare("SELECT tenant_id FROM github_installations WHERE installation_id = ?")
    .bind(record.id)
    .first<{ tenant_id: string }>();
  if (owner !== null && owner.tenant_id !== tenantId) return { kind: "OtherTenant" };
  await db.batch([
    db
      .prepare("DELETE FROM github_installations WHERE tenant_id = ? AND installation_id != ?")
      .bind(tenantId, record.id),
    db
      .prepare(
        `INSERT INTO github_installations (installation_id, tenant_id, account_login, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (installation_id) DO UPDATE SET account_login = excluded.account_login
        WHERE github_installations.tenant_id = excluded.tenant_id`,
      )
      .bind(record.id, tenantId, record.account.login, now),
  ]);
  const linked = await installationOf(db, tenantId);
  return linked === null || linked.installationId !== record.id
    ? { kind: "OtherTenant" }
    : { kind: "Linked", installation: linked };
};

export const unlinkTenant = async (db: D1Database, tenantId: string): Promise<void> => {
  await db.prepare("DELETE FROM github_installations WHERE tenant_id = ?").bind(tenantId).run();
};

export const unlinkInstallation = async (db: D1Database, installationId: number): Promise<void> => {
  await db.prepare("DELETE FROM github_installations WHERE installation_id = ?").bind(installationId).run();
};

export const tenantOfInstallation = async (db: D1Database, installationId: number): Promise<string | null> => {
  const row = await db
    .prepare("SELECT tenant_id FROM github_installations WHERE installation_id = ?")
    .bind(installationId)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
};
