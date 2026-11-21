import { type CreatePushSubscriptionInputSchema, PushSubscriptionSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { seal } from "./envelope.ts";
import { TenantTriggers } from "./tenant-triggers.ts";

export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
type PushSubscriptionCreate = z.infer<typeof CreatePushSubscriptionInputSchema>["subscription"];

type PushSubscriptionRow = {
  push_subscription_id: string;
  principal_id: string;
  endpoint: string;
  created_at: number;
  events: string;
};

const PUSH_SUBSCRIPTION_SELECT = `SELECT p.push_subscription_id, p.principal_id, p.endpoint, p.created_at,
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
    const sql = this.ctx.storage.sql;
    const [existing] = sql
      .exec<{ push_subscription_id: string }>(
        "SELECT push_subscription_id FROM push_subscriptions WHERE endpoint = ?",
        create.endpoint,
      )
      .toArray();
    const pushSubscriptionId = existing?.push_subscription_id ?? crypto.randomUUID();
    const authSealed = await seal(await this.dataKey(), create.keys.auth, authContext(pushSubscriptionId));
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO push_subscriptions
          (push_subscription_id, principal_id, endpoint, p256dh, auth_sealed, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (endpoint) DO UPDATE SET principal_id = excluded.principal_id,
          p256dh = excluded.p256dh, auth_sealed = excluded.auth_sealed, created_at = excluded.created_at`,
        pushSubscriptionId,
        principalId,
        create.endpoint,
        create.keys.p256dh,
        authSealed,
        now,
      );
      sql.exec("DELETE FROM push_subscription_events WHERE push_subscription_id = ?", pushSubscriptionId);
      for (const event of new Set(create.events)) {
        sql.exec(
          "INSERT INTO push_subscription_events (push_subscription_id, event) VALUES (?, ?)",
          pushSubscriptionId,
          event,
        );
      }
    });
    return this.pushSubscription(tenantId, pushSubscriptionId);
  }

  protected deletePushSubscription(principalId: string, pushSubscriptionId: string): boolean {
    return (
      this.ctx.storage.sql.exec(
        "DELETE FROM push_subscriptions WHERE principal_id = ? AND push_subscription_id = ?",
        principalId,
        pushSubscriptionId,
      ).rowsWritten > 0
    );
  }

  private pushSubscription(tenantId: string, pushSubscriptionId: string): PushSubscription {
    const [row] = this.ctx.storage.sql
      .exec<PushSubscriptionRow>(`${PUSH_SUBSCRIPTION_SELECT} WHERE p.push_subscription_id = ?`, pushSubscriptionId)
      .toArray();
    if (row === undefined) throw new Error(`push subscription ${pushSubscriptionId} vanished while it was read back`);
    return toPushSubscription(tenantId, row);
  }
}
