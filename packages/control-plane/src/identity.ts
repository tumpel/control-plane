import { MembershipSchema, type PrincipalRoleSchema, WhoamiSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { sha256Hex, TOKEN_PATTERN } from "./crypto";
import type { GitIdentity } from "./tenant";

export type Whoami = z.infer<typeof WhoamiSchema>;
export type Membership = z.infer<typeof MembershipSchema>;
export type Role = z.infer<typeof PrincipalRoleSchema>;

export interface Caller {
  tenantId: string;
  principalId: string;
  role: Role;
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
  joined_at: number;
}

const WHOAMI_SELECT = `SELECT t.tenant_id, t.name, t.created_at AS tenant_created_at, t.updated_at AS tenant_updated_at,
    p.principal_id, p.email, m.role, p.created_at AS principal_created_at, p.updated_at AS principal_updated_at,
    m.created_at AS joined_at
  FROM memberships m JOIN principals p ON p.principal_id = m.principal_id JOIN tenants t ON t.tenant_id = m.tenant_id`;

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

export const callerOf = (whoami: Whoami): Caller => ({
  tenantId: whoami.tenant.tenantId,
  principalId: whoami.principal.principalId,
  role: whoami.principal.role,
});

export const whoamiOf = async (db: D1Database, caller: Caller): Promise<Whoami> => {
  const row = await db
    .prepare(`${WHOAMI_SELECT} WHERE m.principal_id = ? AND m.tenant_id = ?`)
    .bind(caller.principalId, caller.tenantId)
    .first<WhoamiRow>();
  if (row === null) throw new Error(`principal ${caller.principalId} is no member of tenant ${caller.tenantId}`);
  return toWhoami(row);
};

export const membershipsOfEmail = async (db: D1Database, email: string): Promise<Whoami[]> => {
  const rows = await db
    .prepare(`${WHOAMI_SELECT} WHERE p.email = ? ORDER BY m.created_at, m.tenant_id`)
    .bind(email)
    .all<WhoamiRow>();
  return rows.results.map(toWhoami);
};

export const listTenants = async (db: D1Database, caller: Caller): Promise<Membership[]> => {
  const rows = await db
    .prepare(`${WHOAMI_SELECT} WHERE m.principal_id = ? ORDER BY m.created_at, m.tenant_id`)
    .bind(caller.principalId)
    .all<WhoamiRow>();
  return rows.results.map((row) =>
    MembershipSchema.parse({ tenant: toWhoami(row).tenant, role: row.role, createdAt: row.joined_at }),
  );
};

export const signUp = async (db: D1Database, email: string, name: string, now: number): Promise<Whoami> => {
  const tenantId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO principals (principal_id, email, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING",
      )
      .bind(crypto.randomUUID(), email, now, now),
    db
      .prepare("INSERT INTO tenants (tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(tenantId, name, now, now),
    db
      .prepare(
        `INSERT INTO memberships (tenant_id, principal_id, role, created_at)
        SELECT ?, principal_id, 'Owner', ? FROM principals WHERE email = ?`,
      )
      .bind(tenantId, now, email),
  ]);
  const row = await db
    .prepare(`${WHOAMI_SELECT} WHERE p.email = ? AND m.tenant_id = ?`)
    .bind(email, tenantId)
    .first<WhoamiRow>();
  if (row === null) throw new Error(`sign-up for ${email} wrote no membership of tenant ${tenantId}`);
  return toWhoami(row);
};

export const callerForDeviceToken = async (db: D1Database, token: string, now: number): Promise<Caller | null> => {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await db
    .prepare(
      `SELECT d.device_id, d.tenant_id, d.principal_id, d.last_used_at, m.role FROM devices d
      JOIN memberships m ON m.tenant_id = d.tenant_id AND m.principal_id = d.principal_id
      WHERE d.token_sha256 = ?`,
    )
    .bind(await sha256Hex(token))
    .first<{ device_id: string; tenant_id: string; principal_id: string; last_used_at: number; role: Role }>();
  if (row === null) return null;
  if (now - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    await db.prepare("UPDATE devices SET last_used_at = ? WHERE device_id = ?").bind(now, row.device_id).run();
  }
  return { tenantId: row.tenant_id, principalId: row.principal_id, role: row.role };
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
        "INSERT INTO principals (principal_id, email, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .bind(principalId, email, now, now),
    db
      .prepare(
        `INSERT INTO memberships (tenant_id, principal_id, role, created_at) VALUES (?, ?, 'Owner', ?)
        ON CONFLICT DO NOTHING`,
      )
      .bind(tenantId, principalId, now),
  ]);
  const membership = await db
    .prepare("SELECT role FROM memberships WHERE tenant_id = ? AND principal_id = ?")
    .bind(tenantId, principalId)
    .first<{ role: Role }>();
  if (membership === null) throw new Error(`the proof principal ${principalId} has no membership of ${tenantId}`);
  return {
    caller: { tenantId, principalId, role: membership.role },
    created: tenant?.results.length === 1,
    identity: { gitAuthorName: PROOF_TENANT_NAME, gitAuthorEmail: email },
  };
};
