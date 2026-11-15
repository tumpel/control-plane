import {
  EnrolmentTokenSchema,
  type HostEnrolSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { decodeBase64 } from "./channel/protocol.ts";
import { randomToken, sha256Hex, TOKEN_PATTERN } from "./crypto";
import type { Problem, ProblemStatus } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";

export type Host = z.infer<typeof HostSchema>;
export type MintedEnrolmentToken = z.infer<typeof MintedEnrolmentTokenSchema>;
export type EnrolmentToken = z.infer<typeof EnrolmentTokenSchema>;
export type HostEnrol = z.infer<typeof HostEnrolSchema>;

export type Refused = { ok: false; status: ProblemStatus; problem: Problem };
export type Outcome<T> = { ok: true; value: T } | Refused;

interface HostRow {
  host_id: string;
  tenant_id: string;
  name: string;
  state: string;
  architecture: string;
  cpu_count: number;
  memory_bytes: number;
  public_key: string;
  supervisor_version: string;
  labels: string;
  created_at: number;
  updated_at: number;
}

const HOST_COLUMNS =
  "host_id, tenant_id, name, state, architecture, cpu_count, memory_bytes, public_key, supervisor_version, created_at, updated_at";

const HOST_SELECT = `${HOST_COLUMNS}, labels`;

const toHost = (row: HostRow): Host =>
  HostSchema.parse({
    hostId: row.host_id,
    tenantId: row.tenant_id,
    name: row.name,
    state: row.state,
    architecture: row.architecture,
    cpuCount: row.cpu_count,
    memoryBytes: row.memory_bytes,
    publicKey: row.public_key,
    supervisorVersion: row.supervisor_version,
    labels: JSON.parse(row.labels),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const mintFix = "Mint a new token with tumpel host mint-token and enrol with it";

export const mintEnrolmentToken = async (
  db: D1Database,
  caller: Caller,
  expiresInSeconds: number,
  origin: string,
  now: number,
): Promise<MintedEnrolmentToken> => {
  const token = randomToken();
  const enrolmentTokenId = crypto.randomUUID();
  const expiresAt = now + expiresInSeconds * 1000;
  await db
    .prepare(
      `INSERT INTO enrolment_tokens (enrolment_token_id, token_sha256, tenant_id, principal_id, state, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Unused', ?, ?, ?)`,
    )
    .bind(enrolmentTokenId, await sha256Hex(token), caller.tenantId, caller.principalId, expiresAt, now, now)
    .run();
  return MintedEnrolmentTokenSchema.parse({
    enrolmentToken: {
      enrolmentTokenId,
      tenantId: caller.tenantId,
      principalId: caller.principalId,
      state: "Unused",
      expiresAt: new Date(expiresAt).toISOString(),
      createdAt: now,
      updatedAt: now,
    },
    token,
    installCommand: [
      `curl -fL ${origin}/v1/releases/supervisor/Amd64 -o tumpel-supervisor`,
      "chmod +x tumpel-supervisor",
      `./tumpel-supervisor install --endpoint ${origin} --token-file -`,
    ].join(" && "),
  });
};

export const listEnrolmentTokens = async (db: D1Database, tenantId: string, now: number): Promise<EnrolmentToken[]> => {
  const { results } = await db
    .prepare(
      `SELECT enrolment_token_id, tenant_id, principal_id, state, expires_at, created_at, updated_at
      FROM enrolment_tokens WHERE tenant_id = ? AND state = 'Unused' AND expires_at > ? ORDER BY created_at`,
    )
    .bind(tenantId, now)
    .all<{
      enrolment_token_id: string;
      tenant_id: string;
      principal_id: string;
      state: string;
      expires_at: number;
      created_at: number;
      updated_at: number;
    }>();
  return results.map((row) =>
    EnrolmentTokenSchema.parse({
      enrolmentTokenId: row.enrolment_token_id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      state: row.state,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
};

export const revokeEnrolmentToken = async (
  db: D1Database,
  tenantId: string,
  enrolmentTokenId: string,
  now: number,
): Promise<Outcome<null>> => {
  const revoked = await db
    .prepare(
      `DELETE FROM enrolment_tokens WHERE tenant_id = ? AND enrolment_token_id = ? AND state = 'Unused' AND expires_at > ?
      RETURNING enrolment_token_id`,
    )
    .bind(tenantId, enrolmentTokenId, now)
    .all();
  if (revoked.results.length === 1) return { ok: true, value: null };
  return refuse(404, {
    code: "NotFound",
    title: "No such enrolment token",
    detail: `your tenant has no unused, unexpired enrolment token ${enrolmentTokenId}`,
    fix: "List them with tumpel host list-tokens and revoke one of the ids it prints",
  });
};

const refuse = (status: ProblemStatus, problem: Problem): Refused => ({ ok: false, status, problem });

export const enrolHost = async (env: Env, body: HostEnrol, now: number): Promise<Outcome<Host>> => {
  const key = decodeBase64(body.publicKey);
  if (key === null || key.byteLength !== 32) {
    return refuse(400, {
      code: "InvalidRequest",
      title: "Not an Ed25519 key",
      detail: "publicKey is not the base64 encoding of a 32-byte Ed25519 public key",
      fix: "Enrol with tumpel-supervisor enrol, which makes the key pair",
    });
  }
  const unknown = refuse(404, {
    code: "NotFound",
    title: "Unknown enrolment token",
    detail: "no tenant minted this enrolment token",
    fix: mintFix,
  });
  if (!TOKEN_PATTERN.test(body.enrolmentToken)) return unknown;
  const tokenHash = await sha256Hex(body.enrolmentToken);
  const token = await env.DB.prepare("SELECT tenant_id, state, expires_at FROM enrolment_tokens WHERE token_sha256 = ?")
    .bind(tokenHash)
    .first<{ tenant_id: string; state: string; expires_at: number }>();
  if (token === null) return unknown;
  const spent = refuse(410, {
    code: "EnrolmentTokenSpent",
    title: "Enrolment token spent",
    detail: "another host already enrolled with this token, and a token enrols one host",
    fix: mintFix,
  });
  if (token.state === "Spent") return spent;
  if (token.expires_at <= now) {
    return refuse(410, {
      code: "EnrolmentTokenExpired",
      title: "Enrolment token expired",
      detail: `this enrolment token expired at ${new Date(token.expires_at).toISOString()}`,
      fix: mintFix,
    });
  }
  const hostId = crypto.randomUUID();
  await env.HOST.get(env.HOST.idFromName(hostId)).register(hostId, body.publicKey);
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hosts (${HOST_COLUMNS})
      SELECT ?, tenant_id, ?, 'Enrolled', ?, ?, ?, ?, ?, ?, ?
      FROM enrolment_tokens WHERE token_sha256 = ? AND state = 'Unused' AND expires_at > ?`,
    ).bind(
      hostId,
      body.name,
      body.architecture,
      body.cpuCount,
      body.memoryBytes,
      body.publicKey,
      body.supervisorVersion,
      now,
      now,
      tokenHash,
      now,
    ),
    env.DB.prepare(
      "UPDATE enrolment_tokens SET state = 'Spent', updated_at = ? WHERE token_sha256 = ? AND state = 'Unused'",
    ).bind(now, tokenHash),
  ]);
  if (!inserted?.meta.changes) return spent;
  const host = await hostOf(env.DB, token.tenant_id, hostId);
  if (host === null) throw new Error(`host ${hostId} was enrolled and then not found`);
  return { ok: true, value: host };
};

export const listHosts = async (db: D1Database, tenantId: string): Promise<Host[]> => {
  const { results } = await db
    .prepare(`SELECT ${HOST_SELECT} FROM hosts WHERE tenant_id = ? ORDER BY created_at`)
    .bind(tenantId)
    .all<HostRow>();
  return results.map(toHost);
};

export const hostOf = async (db: D1Database, tenantId: string, hostId: string): Promise<Host | null> => {
  const row = await db
    .prepare(`SELECT ${HOST_SELECT} FROM hosts WHERE tenant_id = ? AND host_id = ?`)
    .bind(tenantId, hostId)
    .first<HostRow>();
  return row === null ? null : toHost(row);
};

export const hostNotFound = (hostId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "Host not found",
    detail: `your tenant has no host ${hostId}`,
    fix: "List your hosts with tumpel host list",
  });

export const revokeHost = async (env: Env, tenantId: string, hostId: string, now: number): Promise<Outcome<Host>> => {
  const host = await hostOf(env.DB, tenantId, hostId);
  if (host === null) return hostNotFound(hostId);
  await env.DB.prepare("UPDATE hosts SET state = 'Revoked', updated_at = ? WHERE host_id = ? AND tenant_id = ?")
    .bind(now, hostId, tenantId)
    .run();
  await env.TENANT.getByName(tenantId).forgetHostUsage(hostId);
  await env.HOST.get(env.HOST.idFromName(hostId)).revoke("the tenant revoked this host");
  return { ok: true, value: { ...host, state: "Revoked", updatedAt: now } };
};

export const setHostLabels = async (
  db: D1Database,
  tenantId: string,
  hostId: string,
  labels: string[],
  now: number,
): Promise<Outcome<Host>> => {
  const host = await hostOf(db, tenantId, hostId);
  if (host === null) return hostNotFound(hostId);
  if (host.state === "Revoked") {
    return refuse(410, {
      code: "HostRevoked",
      title: "Host revoked",
      detail: `host ${hostId} is revoked and takes no labels`,
      fix: "Drop it from your tenant config, or enrol the machine again and label the new host",
    });
  }
  await db
    .prepare("UPDATE hosts SET labels = ?, updated_at = ? WHERE host_id = ? AND tenant_id = ?")
    .bind(JSON.stringify(labels), now, hostId, tenantId)
    .run();
  return { ok: true, value: { ...host, labels, updatedAt: now } };
};
