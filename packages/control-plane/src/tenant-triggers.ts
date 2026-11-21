import {
  type ConfigTriggerSchema,
  type CreateTriggerResultSchema,
  type TriggerCreateSchema,
  type TriggerFiredInputSchema,
  type TriggerFiredResultSchema,
  type TriggerPatchSchema,
  TriggerSchema,
  TriggerStartRefusalSchema,
  type UpdateTriggerResultSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import type { HarnessCatalogEntry } from "./harness-catalog.ts";
import { listHosts, type Outcome, type Refused } from "./hosts.ts";
import { placed } from "./sessions.ts";
import { apiOriginOf } from "./settings.ts";
import type { NewSession } from "./tenant-sessions.ts";
import { TenantWebhooks } from "./tenant-webhooks.ts";
import { conditionRows, conditionsOf } from "./trigger-match.ts";

export type Trigger = z.infer<typeof TriggerSchema>;
type TriggerCreate = z.infer<typeof TriggerCreateSchema>;
type TriggerPatch = z.infer<typeof TriggerPatchSchema>;
type ConfigTrigger = z.infer<typeof ConfigTriggerSchema>;
type TriggerFired = z.infer<typeof TriggerFiredInputSchema>;
type TriggerStartRefusal = z.infer<typeof TriggerStartRefusalSchema>;
type Created = z.infer<typeof CreateTriggerResultSchema>["created"];
type Updated = z.infer<typeof UpdateTriggerResultSchema>["updated"];
type Fired = z.infer<typeof TriggerFiredResultSchema>["fired"];
type Origin = { kind: "Trigger"; triggerId: string; deliveryId: string };

const refusalOf = ({ problem }: Refused): TriggerStartRefusal => {
  const detail = `${problem.detail}. ${problem.fix}`;
  const detailMax = TriggerStartRefusalSchema.shape.detail.maxLength;
  return { code: problem.code, detail: detailMax === null ? detail : detail.slice(0, detailMax).toWellFormed() };
};

type TriggerRow = {
  trigger_id: string;
  name: string;
  source: string;
  event: string;
  persona_id: string;
  model: string;
  prompt: string;
  principal_id: string;
  created_at: number;
  updated_at: number;
  conditions: string;
};

const TRIGGER_SELECT = `SELECT t.trigger_id, t.name, t.source, t.event, t.persona_id, t.model, t.prompt, t.principal_id,
  t.created_at, t.updated_at,
  (SELECT json_group_array(json_object('position', position, 'field', field, 'value', value))
    FROM (SELECT position, field, value FROM trigger_conditions WHERE trigger_id = t.trigger_id ORDER BY position, value)) AS conditions
  FROM triggers AS t`;

const toTrigger = (tenantId: string, row: TriggerRow): Trigger =>
  TriggerSchema.parse({
    triggerId: row.trigger_id,
    tenantId,
    name: row.name,
    source: { kind: row.source, event: row.event, conditions: conditionsOf(JSON.parse(row.conditions)) },
    personaId: row.persona_id,
    model: row.model,
    prompt: row.prompt,
    principalId: row.principal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export abstract class TenantTriggers extends TenantWebhooks {
  protected listTriggers(tenantId: string): Trigger[] {
    return this.ctx.storage.sql
      .exec<TriggerRow>(`${TRIGGER_SELECT} ORDER BY t.created_at, t.trigger_id`)
      .toArray()
      .map((row) => toTrigger(tenantId, row));
  }

  protected getTrigger(tenantId: string, triggerId: string): Trigger | null {
    const [row] = this.ctx.storage.sql
      .exec<TriggerRow>(`${TRIGGER_SELECT} WHERE t.trigger_id = ?`, triggerId)
      .toArray();
    return row === undefined ? null : toTrigger(tenantId, row);
  }

  protected createTrigger(tenantId: string, create: TriggerCreate, principalId: string, now: number): Created {
    if (!this.personaHeld(create.personaId)) return { kind: "PersonaNotFound" };
    if (this.triggerNameTaken(create.name, null)) return { kind: "NameTaken" };
    const triggerId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => this.insertTrigger(triggerId, create, principalId, now));
    return { kind: "Created", trigger: this.presentTrigger(tenantId, triggerId) };
  }

  protected updateTrigger(
    tenantId: string,
    triggerId: string,
    patch: TriggerPatch,
    principalId: string,
    now: number,
  ): Updated {
    const current = this.getTrigger(tenantId, triggerId);
    if (current === null) return { kind: "NotFound" };
    if (patch.personaId !== undefined && !this.personaHeld(patch.personaId)) return { kind: "PersonaNotFound" };
    if (patch.name !== undefined && this.triggerNameTaken(patch.name, triggerId)) return { kind: "NameTaken" };
    this.ctx.storage.transactionSync(() => this.replaceTrigger(triggerId, { ...current, ...patch }, principalId, now));
    return { kind: "Updated", trigger: this.presentTrigger(tenantId, triggerId) };
  }

  protected deleteTrigger(triggerId: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM triggers WHERE trigger_id = ?", triggerId).rowsWritten > 0;
  }

  protected writeConfigTrigger(
    triggerId: string | null,
    trigger: ConfigTrigger,
    principalId: string,
    now: number,
  ): void {
    const { personaName, ...fields } = trigger;
    const [persona] = this.ctx.storage.sql
      .exec<{ persona_id: string }>("SELECT persona_id FROM personas WHERE name = ?", personaName)
      .toArray();
    if (persona === undefined) {
      throw new Error(`trigger ${trigger.name} names persona ${personaName}, which the apply did not hold`);
    }
    const write = { ...fields, personaId: persona.persona_id };
    if (triggerId === null) this.insertTrigger(crypto.randomUUID(), write, principalId, now);
    else this.replaceTrigger(triggerId, write, principalId, now);
  }

  protected async triggerFired(
    input: TriggerFired,
    check: (trigger: Trigger) => Outcome<HarnessCatalogEntry>,
  ): Promise<Fired> {
    const { tenantId, triggerId, deliveryId, fired, now } = input;
    const origin = { kind: "Trigger" as const, triggerId, deliveryId };
    const trigger = this.getTrigger(tenantId, triggerId);
    if (trigger === null) return { kind: "NotFound" };
    const repeated = this.startedFor(triggerId, deliveryId);
    if (repeated !== null) return { kind: "Repeated", sessionId: repeated };
    if (fired.kind === "Refused") return this.refuseStart(origin, fired.refusal, now);
    const checked = check(trigger);
    if (!checked.ok) return this.refuseStart(origin, refusalOf(checked), now);
    const entry = checked.value;
    const session: NewSession = {
      principalId: trigger.principalId,
      startedBy: origin,
      hosts: await listHosts(this.env.DB, tenantId),
      harness: entry.harness,
      harnessVersion: entry.harnessVersion,
      endpoint: apiOriginOf(this.env),
      start: { personaId: trigger.personaId, repository: fired.repository, model: trigger.model, prompt: fired.prompt },
    };
    const started = placed(
      await this.begin(tenantId, session, now, (sessionId) => {
        this.ctx.storage.sql.exec(
          "INSERT INTO session_trigger_origins (session_id, trigger_id, delivery_id) VALUES (?, ?, ?)",
          sessionId,
          origin.triggerId,
          origin.deliveryId,
        );
      }),
    );
    if (started.ok) return { kind: "Started", started: started.value };
    return this.refuseStart(origin, refusalOf(started), now);
  }

  private refuseStart(origin: Origin, refusal: TriggerStartRefusal, now: number): Fired {
    this.appendEvent(
      { event: "TriggerStartRefused", triggerId: origin.triggerId, deliveryId: origin.deliveryId, refusal },
      now,
    );
    return { kind: "Refused", refusal };
  }

  private startedFor(triggerId: string, deliveryId: string): string | null {
    const [row] = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        "SELECT session_id FROM session_trigger_origins WHERE trigger_id = ? AND delivery_id = ?",
        triggerId,
        deliveryId,
      )
      .toArray();
    return row?.session_id ?? null;
  }

  private personaHeld(personaId: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM personas WHERE persona_id = ?", personaId).toArray().length > 0;
  }

  private triggerNameTaken(name: string, triggerId: string | null): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM triggers WHERE name = ? AND trigger_id IS NOT ?", name, triggerId)
        .toArray().length > 0
    );
  }

  private insertTrigger(triggerId: string, trigger: TriggerCreate, principalId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO triggers (trigger_id, name, source, event, persona_id, model, prompt, principal_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      triggerId,
      trigger.name,
      trigger.source.kind,
      trigger.source.event,
      trigger.personaId,
      trigger.model,
      trigger.prompt,
      principalId,
      now,
      now,
    );
    this.writeConditions(triggerId, trigger.source.conditions);
  }

  private replaceTrigger(triggerId: string, trigger: TriggerCreate, principalId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE triggers SET name = ?, source = ?, event = ?, persona_id = ?, model = ?, prompt = ?, principal_id = ?, updated_at = MAX(?, updated_at + 1)
      WHERE trigger_id = ?`,
      trigger.name,
      trigger.source.kind,
      trigger.source.event,
      trigger.personaId,
      trigger.model,
      trigger.prompt,
      principalId,
      now,
      triggerId,
    );
    this.ctx.storage.sql.exec("DELETE FROM trigger_conditions WHERE trigger_id = ?", triggerId);
    this.writeConditions(triggerId, trigger.source.conditions);
  }

  private writeConditions(triggerId: string, conditions: TriggerCreate["source"]["conditions"]): void {
    for (const row of conditionRows(conditions)) {
      this.ctx.storage.sql.exec(
        "INSERT INTO trigger_conditions (trigger_id, position, field, value) VALUES (?, ?, ?, ?)",
        triggerId,
        row.position,
        row.field,
        row.value,
      );
    }
  }

  private presentTrigger(tenantId: string, triggerId: string): Trigger {
    const trigger = this.getTrigger(tenantId, triggerId);
    if (trigger === null) throw new Error(`trigger ${triggerId} vanished while it was read back`);
    return trigger;
  }
}
