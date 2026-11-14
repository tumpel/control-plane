import { WhoamiSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { sha256Hex, TOKEN_PATTERN } from "./crypto";
import type { GitIdentity } from "./tenant";

export type Whoami = z.infer<typeof WhoamiSchema>;

export interface Caller {
  tenantId: string;
  principalId: string;
}

const LAST_USED_RESOLUTION_MS = 3_600_000;

interface WhoamiRow {
  tenant_id: string;
  name: string;
  tenant_created_at: number;
  tenant_updated_at: number;
  principal_id: string;
  email: string;
  role: string;
  principal_created_at: number;
  principal_updated_at: number;
}

const WHOAMI_SELECT = `SELECT t.tenant_id, t.name, t.created_at AS tenant_created_at, t.updated_at AS tenant_updated_at,
    p.principal_id, p.email, p.role, p.created_at AS principal_created_at, p.updated_at AS principal_updated_at
  FROM principals p JOIN tenants t ON t.tenant_id = p.tenant_id`;

const toWhoami = (row: WhoamiRow): Whoami =>
  WhoamiSchema.parse({
    tenant: {
      tenantId: row.tenant_id,
      name: row.name,
      createdAt: row.tenant_created_at,
      updatedAt: row.tenant_updated_at,
    },
    principal: {
      principalId: row.principal_id,
      tenantId: row.tenant_id,
      email: row.email,
      role: row.role,
      createdAt: row.principal_created_at,
      updatedAt: row.principal_updated_at,
    },
  });

export const whoamiOf = async (db: D1Database, caller: Caller): Promise<Whoami> => {
  const row = await db
    .prepare(`${WHOAMI_SELECT} WHERE p.principal_id = ? AND p.tenant_id = ?`)
    .bind(caller.principalId, caller.tenantId)
    .first<WhoamiRow>();
  if (row === null) throw new Error(`principal ${caller.principalId} of tenant ${caller.tenantId} has no row`);
  return toWhoami(row);
};

export const whoamiForEmail = async (db: D1Database, email: string): Promise<Whoami | null> => {
  const row = await db.prepare(`${WHOAMI_SELECT} WHERE p.email = ?`).bind(email).first<WhoamiRow>();
  return row === null ? null : toWhoami(row);
};

export const signUp = async (db: D1Database, email: string, name: string, now: number): Promise<Whoami> => {
  const tenantId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO tenants (tenant_id, name, created_at, updated_at)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM principals WHERE email = ?)`,
      )
      .bind(tenantId, name, now, now, email),
    db
      .prepare(
        `INSERT INTO principals (principal_id, tenant_id, email, role, created_at, updated_at)
        SELECT ?, ?, ?, 'Owner', ?, ? WHERE EXISTS (SELECT 1 FROM tenants WHERE tenant_id = ?)
          AND NOT EXISTS (SELECT 1 FROM principals WHERE email = ?)`,
      )
      .bind(crypto.randomUUID(), tenantId, email, now, now, tenantId, email),
  ]);
  const whoami = await whoamiForEmail(db, email);
  if (whoami === null) throw new Error(`sign-up for ${email} wrote no principal`);
  return whoami;
};

export const callerForDeviceToken = async (db: D1Database, token: string, now: number): Promise<Caller | null> => {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db
    .prepare("SELECT device_id, tenant_id, principal_id, last_used_at FROM devices WHERE token_sha256 = ?")
    .bind(await sha256Hex(token))
    .first<{ device_id: string; tenant_id: string; principal_id: string; last_used_at: number }>();
  if (row === null) return null;
  if (now - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    await db.prepare("UPDATE devices SET last_used_at = ? WHERE device_id = ?").bind(now, row.device_id).run();
  }
  return { tenantId: row.tenant_id, principalId: row.principal_id };
};

export const bearerOf = (request: Request): string => {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
};

const PROOF_TENANT_NAME = "Tumpel proof";

const derivedId = async (purpose: string, commonName: string): Promise<string> => {
  const hex = await sha256Hex(`${purpose}:${commonName}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export const proofCaller = async (
  db: D1Database,
  commonName: string,
  hostname: string,
  now: number,
): Promise<{ caller: Caller; created: boolean; identity: GitIdentity }> => {
  const tenantId = await derivedId("tenant", commonName);
  const principalId = await derivedId("principal", commonName);
  const email = `proof+${principalId.slice(0, 8)}@${hostname}`;
  const [tenant] = await db.batch([
    db
      .prepare(
        `INSERT INTO tenants (tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT DO NOTHING RETURNING tenant_id`,
      )
      .bind(tenantId, PROOF_TENANT_NAME, now, now),
    db
      .prepare(
        `INSERT INTO principals (principal_id, tenant_id, email, role, created_at, updated_at)
        VALUES (?, ?, ?, 'Owner', ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(principalId, tenantId, email, now, now),
  ]);
  return {
    caller: { tenantId, principalId },
    created: tenant?.results.length === 1,
    identity: { gitAuthorName: PROOF_TENANT_NAME, gitAuthorEmail: email },
  };
};
