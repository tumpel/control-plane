import type { SupervisorUpdateFailureReportSchema, SupervisorUpdateStepReportSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import type { HostMessage } from "./channel/protocol.ts";

export type SupervisorUpdateMessage = Extract<HostMessage, { type: "SupervisorUpdateStep" | "SupervisorUpdateFailed" }>;
type StepReport = z.infer<typeof SupervisorUpdateStepReportSchema>;
type FailureReport = z.infer<typeof SupervisorUpdateFailureReportSchema>;

const KEPT = 5;

export const isSupervisorUpdate = (message: HostMessage): message is SupervisorUpdateMessage =>
  message.type === "SupervisorUpdateStep" || message.type === "SupervisorUpdateFailed";

type StepRow = { from_sha256: string; to_sha256: string; phase: StepReport["phase"]; at: string };
type FailureRow = {
  from_sha256: string;
  to_sha256: string;
  reason: FailureReport["reason"];
  detail: string;
  output_tail: string;
  failed_at: string;
};

export const recordSupervisorUpdate = (
  sql: SqlStorage,
  hostId: string,
  message: SupervisorUpdateMessage,
  now: number,
): void => {
  if (message.type === "SupervisorUpdateStep") {
    sql.exec(
      "INSERT INTO supervisor_update_steps (supervisor_update_step_id, host_id, from_sha256, to_sha256, phase, at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      hostId,
      message.fromSha256,
      message.toSha256,
      message.phase,
      message.at,
      now,
    );
    sql.exec(
      `DELETE FROM supervisor_update_steps WHERE host_id = ?1 AND supervisor_update_step_id NOT IN (
        SELECT supervisor_update_step_id FROM supervisor_update_steps WHERE host_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ${KEPT})`,
      hostId,
    );
    return;
  }
  sql.exec(
    "INSERT INTO supervisor_update_failures (supervisor_update_failure_id, host_id, from_sha256, to_sha256, reason, detail, output_tail, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    crypto.randomUUID(),
    hostId,
    message.fromSha256,
    message.toSha256,
    message.reason,
    message.detail,
    JSON.stringify(message.outputTail),
    message.failedAt,
    now,
  );
  sql.exec(
    `DELETE FROM supervisor_update_failures WHERE host_id = ?1 AND supervisor_update_failure_id NOT IN (
      SELECT supervisor_update_failure_id FROM supervisor_update_failures WHERE host_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ${KEPT})`,
    hostId,
  );
};

export const supervisorUpdatesOf = (
  sql: SqlStorage,
  hostId: string,
): { supervisorUpdateSteps: StepReport[]; supervisorUpdateFailures: FailureReport[] } => ({
  supervisorUpdateSteps: sql
    .exec<StepRow>(
      "SELECT from_sha256, to_sha256, phase, at FROM supervisor_update_steps WHERE host_id = ? ORDER BY created_at DESC, rowid DESC",
      hostId,
    )
    .toArray()
    .map((row) => ({ fromSha256: row.from_sha256, toSha256: row.to_sha256, phase: row.phase, at: row.at })),
  supervisorUpdateFailures: sql
    .exec<FailureRow>(
      "SELECT from_sha256, to_sha256, reason, detail, output_tail, failed_at FROM supervisor_update_failures WHERE host_id = ? ORDER BY created_at DESC, rowid DESC",
      hostId,
    )
    .toArray()
    .map((row) => ({
      fromSha256: row.from_sha256,
      toSha256: row.to_sha256,
      reason: row.reason,
      detail: row.detail,
      outputTail: JSON.parse(row.output_tail),
      failedAt: row.failed_at,
    })),
});

export const forgetSupervisorUpdates = (sql: SqlStorage, hostId: string): void => {
  sql.exec("DELETE FROM supervisor_update_steps WHERE host_id = ?", hostId);
  sql.exec("DELETE FROM supervisor_update_failures WHERE host_id = ?", hostId);
};
