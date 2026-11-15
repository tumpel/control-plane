import type { SupervisorUpdateLatestFailureSchema, SupervisorUpdateLatestStepSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import type { HostMessage } from "./channel/protocol.ts";

export type SupervisorUpdateMessage = Extract<HostMessage, { type: "SupervisorUpdateStep" | "SupervisorUpdateFailed" }>;
type LatestStep = z.infer<typeof SupervisorUpdateLatestStepSchema>;
type LatestFailure = z.infer<typeof SupervisorUpdateLatestFailureSchema>;
export type SupervisorUpdates = { supervisorUpdateStep: LatestStep; supervisorUpdateFailure: LatestFailure };

export const isSupervisorUpdate = (message: HostMessage): message is SupervisorUpdateMessage =>
  message.type === "SupervisorUpdateStep" || message.type === "SupervisorUpdateFailed";

type StepRow = {
  host_id: string;
  from_sha256: string;
  to_sha256: string;
  phase: Extract<LatestStep, { state: "Reported" }>["step"]["phase"];
  at: string;
};
type FailureRow = {
  host_id: string;
  from_sha256: string;
  to_sha256: string;
  reason: Extract<LatestFailure, { state: "Reported" }>["failure"]["reason"];
  detail: string;
  output_tail: string;
  failed_at: string;
};

const NOT_REPORTED = { state: "NotReported" } as const;

export const NO_SUPERVISOR_UPDATES: SupervisorUpdates = {
  supervisorUpdateStep: NOT_REPORTED,
  supervisorUpdateFailure: NOT_REPORTED,
};

export const recordSupervisorUpdate = (
  sql: SqlStorage,
  hostId: string,
  message: SupervisorUpdateMessage,
  now: number,
): void => {
  if (message.type === "SupervisorUpdateStep") {
    sql.exec(
      `INSERT INTO supervisor_update_latest_steps (host_id, from_sha256, to_sha256, phase, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (host_id) DO UPDATE SET from_sha256 = excluded.from_sha256, to_sha256 = excluded.to_sha256,
        phase = excluded.phase, at = excluded.at, updated_at = excluded.updated_at`,
      hostId,
      message.fromSha256,
      message.toSha256,
      message.phase,
      message.at,
      now,
    );
    return;
  }
  sql.exec(
    `INSERT INTO supervisor_update_latest_failures (host_id, from_sha256, to_sha256, reason, detail, output_tail, failed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host_id) DO UPDATE SET from_sha256 = excluded.from_sha256, to_sha256 = excluded.to_sha256,
      reason = excluded.reason, detail = excluded.detail, output_tail = excluded.output_tail,
      failed_at = excluded.failed_at, updated_at = excluded.updated_at`,
    hostId,
    message.fromSha256,
    message.toSha256,
    message.reason,
    message.detail,
    JSON.stringify(message.outputTail),
    message.failedAt,
    now,
  );
};

export const supervisorUpdatesByHost = (sql: SqlStorage): Record<string, SupervisorUpdates> => {
  const byHost: Record<string, SupervisorUpdates> = {};
  const of = (hostId: string): SupervisorUpdates => {
    byHost[hostId] ??= { ...NO_SUPERVISOR_UPDATES };
    return byHost[hostId];
  };
  for (const row of sql
    .exec<StepRow>("SELECT host_id, from_sha256, to_sha256, phase, at FROM supervisor_update_latest_steps")
    .toArray()) {
    of(row.host_id).supervisorUpdateStep = {
      state: "Reported",
      step: { fromSha256: row.from_sha256, toSha256: row.to_sha256, phase: row.phase, at: row.at },
    };
  }
  for (const row of sql
    .exec<FailureRow>(
      "SELECT host_id, from_sha256, to_sha256, reason, detail, output_tail, failed_at FROM supervisor_update_latest_failures",
    )
    .toArray()) {
    of(row.host_id).supervisorUpdateFailure = {
      state: "Reported",
      failure: {
        fromSha256: row.from_sha256,
        toSha256: row.to_sha256,
        reason: row.reason,
        detail: row.detail,
        outputTail: JSON.parse(row.output_tail),
        failedAt: row.failed_at,
      },
    };
  }
  return byHost;
};

export const forgetSupervisorUpdates = (sql: SqlStorage, hostId: string): void => {
  sql.exec("DELETE FROM supervisor_update_latest_steps WHERE host_id = ?", hostId);
  sql.exec("DELETE FROM supervisor_update_latest_failures WHERE host_id = ?", hostId);
};
