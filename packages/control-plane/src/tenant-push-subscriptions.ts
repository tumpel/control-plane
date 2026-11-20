import {
  type CreatePushSubscriptionInputSchema,
  type PushDeliveryTargetSchema,
  PushSubscriptionSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { seal, unseal } from "./envelope.ts";
import { endOfLog, type NewTenantEvent } from "./tenant-events.ts";
import { TenantTriggers } from "./tenant-triggers.ts";

export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
type PushSubscriptionCreate = z.infer<typeof CreatePushSubscriptionInputSchema>["subscription"];
type PushDeliveryTarget = z.infer<typeof PushDeliveryTargetSchema>;

type PushSubscriptionRow = {
  push_subscription_id: string;
  principal_id: string;
  endpoint: string;
  p256dh: string;
  auth_sealed: string;
  created_at: number;
  events: string;
};

const PUSH_SUBSCRIPTION_SELECT = `SELECT p.push_subscription_id, p.principal_id, p.endpoint, p.p256dh,
  p.auth_sealed, p.created_at,
  (SELECT json_group_array(event) FROM (SELECT event FROM push_subscription_events
    WHERE push_subscription_id = p.push_subscription_id ORDER BY event)) AS events
  FROM push_subscriptions AS p`;

const authContext = (pushSubscriptionId: string): string => `push-subscription/${pushSubscriptionId}/auth`;

const toPushSubscription = (tenantId: string, row: PushSubscriptionRow): PushSubscription =>
  PushSubscriptionSchema.parse({
    pushSubscriptionId: row.push_subscription_id,
    tenantId,
    principalId: row.principal_id,
    endpoint: row.endpoint,
    events: JSON.parse(row.events),
    createdAt: row.created_at,
  });

export abstract class TenantPushSubscriptions extends TenantTriggers {
  protected listPushSubscriptions(tenantId: string, principalId: string): PushSubscription[] {
    return this.ctx.storage.sql
      .exec<PushSubscriptionRow>(
        `${PUSH_SUBSCRIPTION_SELECT} WHERE p.principal_id = ? ORDER BY p.created_at, p.push_subscription_id`,
        principalId,
      )
      .toArray()
      .map((row) => toPushSubscription(tenantId, row));
  }

  protected async createPushSubscription(
    tenantId: string,
    principalId: string,
    create: PushSubscriptionCreate,
    now: number,
  ): Promise<PushSubscription> {
    const pushSubscriptionId = crypto.randomUUID();
    const authSealed = await seal(await this.dataKey(), create.keys.auth, authContext(pushSubscriptionId));
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO push_subscriptions
          (push_subscription_id, principal_id, endpoint, p256dh, auth_sealed, cursor_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        pushSubscriptionId,
        principalId,
        create.endpoint,
        create.keys.p256dh,
        authSealed,
        endOfLog(sql),
        now,
      );
      for (const event of new Set(create.events)) {
        sql.exec(
          "INSERT INTO push_subscription_events (push_subscription_id, event) VALUES (?, ?)",
          pushSubscriptionId,
          event,
        );
      }
    });
    await this.env.PUSH_SENDER.getByName(pushSubscriptionId).start(tenantId, pushSubscriptionId, endOfLog(sql));
    return this.pushSubscription(tenantId, pushSubscriptionId);
  }

  protected async deletePushSubscription(principalId: string, pushSubscriptionId: string): Promise<boolean> {
    const deleted =
      this.ctx.storage.sql.exec(
        "DELETE FROM push_subscriptions WHERE principal_id = ? AND push_subscription_id = ?",
        principalId,
        pushSubscriptionId,
      ).rowsWritten > 0;
    if (deleted) await this.env.PUSH_SENDER.getByName(pushSubscriptionId).drop();
    return deleted;
  }

  protected forgetPushSubscription(pushSubscriptionId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM push_subscriptions WHERE push_subscription_id = ?", pushSubscriptionId);
  }

  protected async pushTarget(pushSubscriptionId: string): Promise<PushDeliveryTarget | null> {
    const [row] = this.ctx.storage.sql
      .exec<PushSubscriptionRow>(`${PUSH_SUBSCRIPTION_SELECT} WHERE p.push_subscription_id = ?`, pushSubscriptionId)
      .toArray();
    if (row === undefined) return null;
    return {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: await unseal(
          await this.dataKey(),
          row.auth_sealed,
          authContext(pushSubscriptionId),
          "turn notifications off and on again for this browser",
        ),
      },
      events: JSON.parse(row.events),
    };
  }

  protected override appendEvent(event: NewTenantEvent, now: number): number {
    const eventId = super.appendEvent(event, now);
    const subscriptions = this.ctx.storage.sql
      .exec<{ push_subscription_id: string }>(
        "SELECT push_subscription_id FROM push_subscription_events WHERE event = ? ORDER BY push_subscription_id",
        event.event,
      )
      .toArray();
    for (const row of subscriptions)
      this.ctx.waitUntil(this.env.PUSH_SENDER.getByName(row.push_subscription_id).wake());
    return eventId;
  }

  private pushSubscription(tenantId: string, pushSubscriptionId: string): PushSubscription {
    const [row] = this.ctx.storage.sql
      .exec<PushSubscriptionRow>(`${PUSH_SUBSCRIPTION_SELECT} WHERE p.push_subscription_id = ?`, pushSubscriptionId)
      .toArray();
    if (row === undefined) throw new Error(`push subscription ${pushSubscriptionId} was inserted and is gone`);
    return toPushSubscription(tenantId, row);
  }
}
