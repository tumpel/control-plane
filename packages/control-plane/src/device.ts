import { DeviceSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { randomToken, sha256Hex } from "./crypto";
import type { Caller } from "./identity";

export type Device = z.infer<typeof DeviceSchema>;

export const DEVICE_CODE_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 5;
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SLOW_DOWN_STEP_S = 5;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

export interface DeviceCodeLimits {
  perClient: number;
  total: number;
}

export const DEVICE_CODE_LIMITS: DeviceCodeLimits = { perClient: 5, total: 200 };

export type PollError = "invalid_grant" | "expired_token" | "slow_down" | "authorization_pending";

export type PollOutcome = { ok: true; accessToken: string } | { ok: false; error: PollError };

export const GRANT_ERRORS: Record<PollError, string> = {
  invalid_grant: "the device code is unknown, denied or already used; run tumpel login again",
  expired_token: "the device code expired; run tumpel login again",
  slow_down: "polling too fast; wait the interval plus five seconds",
  authorization_pending: "waiting for approval in the browser",
};

const newUserCode = (): string => {
  let code = "";
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 240 && code.length < USER_CODE_LENGTH) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
};

export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export const parseUserCode = (input: string): string | null => {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  return [...code].every((char) => USER_CODE_ALPHABET.includes(char)) ? code : null;
};

export const startDeviceCode = async (
  db: D1Database,
  deviceName: string,
  clientIp: string,
  limits: DeviceCodeLimits,
  now: number,
): Promise<{ deviceCode: string; userCode: string } | null> => {
  const deviceCode = randomToken();
  const userCode = newUserCode();
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        `INSERT INTO device_codes (device_code_sha256, user_code, device_name, client_ip, created_at, expires_at,
          interval_s, last_polled_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT count(*) FROM device_codes WHERE expires_at > ?) < ?
          AND (SELECT count(*) FROM device_codes WHERE client_ip = ? AND expires_at > ?) < ?
        RETURNING user_code`,
      )
      .bind(
        await sha256Hex(deviceCode),
        userCode,
        deviceName,
        clientIp,
        now,
        now + DEVICE_CODE_TTL_MS,
        POLL_INTERVAL_S,
        now,
        now,
        limits.total,
        clientIp,
        now,
        limits.perClient,
      ),
  ]);
  return inserted?.results.length === 1 ? { deviceCode, userCode } : null;
};

const UNDECIDED = `user_code = ? AND expires_at > ?
  AND NOT EXISTS (SELECT 1 FROM device_approvals a WHERE a.device_code_sha256 = device_codes.device_code_sha256)`;

export interface PendingDeviceCode {
  userCode: string;
  deviceName: string;
}

export const pendingDeviceCode = async (
  db: D1Database,
  userCode: string,
  now: number,
): Promise<PendingDeviceCode | null> => {
  const row = await db
    .prepare(`SELECT user_code, device_name FROM device_codes WHERE ${UNDECIDED}`)
    .bind(userCode, now)
    .first<{ user_code: string; device_name: string }>();
  return row === null ? null : { userCode: row.user_code, deviceName: row.device_name };
};

export const denyDeviceCode = async (db: D1Database, userCode: string, now: number): Promise<boolean> => {
  const denied = await db
    .prepare(`DELETE FROM device_codes WHERE ${UNDECIDED} RETURNING user_code`)
    .bind(userCode, now)
    .all();
  return denied.results.length === 1;
};

export const approveDeviceCode = async (
  db: D1Database,
  userCode: string,
  caller: Caller,
  now: number,
): Promise<Device | null> => {
  const pending = await db
    .prepare(`SELECT device_code_sha256, device_name FROM device_codes WHERE ${UNDECIDED}`)
    .bind(userCode, now)
    .first<{ device_code_sha256: string; device_name: string }>();
  if (pending === null) return null;
  const deviceId = crypto.randomUUID();
  const approved = await db
    .prepare(
      `INSERT INTO device_approvals (device_code_sha256, device_id, tenant_id, principal_id, approved_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING device_id`,
    )
    .bind(pending.device_code_sha256, deviceId, caller.tenantId, caller.principalId, now)
    .all();
  if (approved.results.length !== 1) return null;
  return DeviceSchema.parse({
    deviceId,
    tenantId: caller.tenantId,
    principalId: caller.principalId,
    name: pending.device_name,
    createdAt: now,
    lastUsedAt: now,
  });
};

interface PollRow {
  expires_at: number;
  interval_s: number;
  last_polled_at: number;
  device_id: string | null;
}

export const pollDeviceCode = async (db: D1Database, deviceCode: string, now: number): Promise<PollOutcome> => {
  const codeHash = await sha256Hex(deviceCode);
  const row = await db
    .prepare(
      `SELECT dc.expires_at, dc.interval_s, dc.last_polled_at, a.device_id
      FROM device_codes dc LEFT JOIN device_approvals a ON a.device_code_sha256 = dc.device_code_sha256
      WHERE dc.device_code_sha256 = ?`,
    )
    .bind(codeHash)
    .first<PollRow>();
  if (row === null) return { ok: false, error: "invalid_grant" };
  if (now >= row.expires_at) {
    await db.prepare("DELETE FROM device_codes WHERE device_code_sha256 = ?").bind(codeHash).run();
    return { ok: false, error: "expired_token" };
  }
  if (now - row.last_polled_at < row.interval_s * 1000) {
    await db
      .prepare("UPDATE device_codes SET interval_s = ?, last_polled_at = ? WHERE device_code_sha256 = ?")
      .bind(row.interval_s + SLOW_DOWN_STEP_S, now, codeHash)
      .run();
    return { ok: false, error: "slow_down" };
  }
  if (row.device_id === null) {
    await db
      .prepare("UPDATE device_codes SET last_polled_at = ? WHERE device_code_sha256 = ?")
      .bind(now, codeHash)
      .run();
    return { ok: false, error: "authorization_pending" };
  }
  const accessToken = randomToken();
  const [issued] = await db.batch([
    db
      .prepare(
        `INSERT INTO devices (device_id, token_sha256, tenant_id, principal_id, name, created_at, last_used_at)
        SELECT a.device_id, ?, a.tenant_id, a.principal_id, dc.device_name, a.approved_at, a.approved_at
        FROM device_codes dc JOIN device_approvals a ON a.device_code_sha256 = dc.device_code_sha256
        WHERE dc.device_code_sha256 = ?
        RETURNING device_id`,
      )
      .bind(await sha256Hex(accessToken), codeHash),
    db.prepare("DELETE FROM device_codes WHERE device_code_sha256 = ?").bind(codeHash),
  ]);
  if (issued?.results.length !== 1) return { ok: false, error: "invalid_grant" };
  return { ok: true, accessToken };
};

interface DeviceRow {
  device_id: string;
  tenant_id: string;
  principal_id: string;
  name: string;
  created_at: number;
  last_used_at: number;
}

export const listDevices = async (db: D1Database, caller: Caller): Promise<Device[]> => {
  const rows = await db
    .prepare(
      `SELECT device_id, tenant_id, principal_id, name, created_at, last_used_at FROM devices
      WHERE tenant_id = ? AND principal_id = ? ORDER BY created_at, device_id`,
    )
    .bind(caller.tenantId, caller.principalId)
    .all<DeviceRow>();
  return rows.results.map((row) =>
    DeviceSchema.parse({
      deviceId: row.device_id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }),
  );
};

export const revokeDevice = async (db: D1Database, caller: Caller, deviceId: string): Promise<boolean> => {
  const revoked = await db
    .prepare("DELETE FROM devices WHERE tenant_id = ? AND principal_id = ? AND device_id = ? RETURNING device_id")
    .bind(caller.tenantId, caller.principalId, deviceId)
    .all();
  return revoked.results.length === 1;
};
