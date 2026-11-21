import { type CreatePushSubscriptionInputSchema, PushSubscriptionSchema, TenantEventSchema } from "@tumpel/schemas";
import { v5 as uuidV5 } from "uuid";
import type { z } from "zod";
import { seal, unseal } from "./envelope.ts";
import { pushNotification, pushSessionName } from "./push-notification.ts";
import type { PushDelivery } from "./push-sender.ts";
import type { NewTenantEvent } from "./tenant-events.ts";
import { TenantTriggers } from "./tenant-triggers.ts";
import { pushRequest } from "./web-push.ts";

export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
type PushSubscriptionCreate = z.infer<typeof CreatePushSubscriptionInputSchema>["subscription"];

type PushSubscriptionRow = {
  push_subscription_id: string;
  principal_id: string;
  endpoint: string;
  created_at: number;
  events: string;
};

type PushWakeRow = {
  event_id: number;
  principal_id: string;
  push_subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth_sealed: string;
  payload: string;
  event_created_at: number;
  repository: string;
};

const PUSH_SUBSCRIPTION_SELECT = `SELECT p.push_subscription_id, p.principal_id, p.endpoint, p.created_at,
  (SELECT json_group_array(event) FROM (SELECT event FROM push_subscription_events
    WHERE push_subscription_id = p.push_subscription_id ORDER BY event)) AS events
  FROM push_subscriptions AS p`;
const PUSH_SUBSCRIPTION_NAMESPACE = uuidV5("tumpel:push-subscription", uuidV5.URL);

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
    const pushSubscriptionId = uuidV5(create.endpoint, PUSH_SUBSCRIPTION_NAMESPACE);
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

  protected async pendingPushDeliveries(tenantId: string): Promise<PushDelivery[]> {
    const rows = this.ctx.storage.sql
      .exec<PushWakeRow>(
        `SELECT w.event_id, p.principal_id, p.push_subscription_id, p.endpoint, p.p256dh, p.auth_sealed,
          e.payload, e.created_at AS event_created_at, s.repository FROM push_wakes AS w
          JOIN push_subscriptions AS p USING (push_subscription_id)
          JOIN events AS e USING (event_id)
          JOIN event_sessions AS es USING (event_id)
          JOIN sessions AS s USING (session_id)
          ORDER BY w.event_id, p.push_subscription_id`,
      )
      .toArray();
    if (rows.length === 0) return [];
    const dataKey = await this.dataKey();
    return Promise.all(
      rows.map(async (row) => {
        const event = TenantEventSchema.parse({
          ...JSON.parse(row.payload),
          eventId: row.event_id,
          tenantId,
          createdAt: row.event_created_at,
        });
        if (event.event !== "SubscriptionPaused" && event.event !== "SubscriptionEnded") {
          throw new Error(`push wake ${row.event_id} holds unsupported event ${event.event}`);
        }
        const request = await pushRequest(
          row.endpoint,
          JSON.stringify(pushNotification(event, pushSessionName(row.repository))),
          row.p256dh,
          await unseal(
            dataKey,
            row.auth_sealed,
            authContext(row.push_subscription_id),
            "turn notifications off and on again for this browser",
          ),
          this.env.VAPID_PRIVATE_KEY,
          this.env.VAPID_PUBLIC_KEY,
          this.env.VAPID_SUBJECT,
          Date.now(),
        );
        return {
          eventId: row.event_id,
          tenantId,
          principalId: row.principal_id,
          pushSubscriptionId: row.push_subscription_id,
          endpoint: row.endpoint,
          headers: [...request.headers.entries()],
          body: new Uint8Array(await request.arrayBuffer()),
        };
      }),
    );
  }

  protected completePushWake(eventId: number, pushSubscriptionId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM push_wakes WHERE event_id = ? AND push_subscription_id = ?",
      eventId,
      pushSubscriptionId,
    );
  }

  protected override appendEvent(event: NewTenantEvent, now: number): number {
    const eventId = super.appendEvent(event, now);
    if (event.event !== "SubscriptionPaused" && event.event !== "SubscriptionEnded") return eventId;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO push_wakes (event_id, push_subscription_id)
        SELECT ?, push_subscription_id FROM push_subscription_events WHERE event = ?`,
      eventId,
      event.event,
    );
    return eventId;
  }

  private pushSubscription(tenantId: string, pushSubscriptionId: string): PushSubscription {
    const [row] = this.ctx.storage.sql
      .exec<PushSubscriptionRow>(`${PUSH_SUBSCRIPTION_SELECT} WHERE p.push_subscription_id = ?`, pushSubscriptionId)
      .toArray();
    if (row === undefined) throw new Error(`push subscription ${pushSubscriptionId} vanished while it was read back`);
    return toPushSubscription(tenantId, row);
  }
}
