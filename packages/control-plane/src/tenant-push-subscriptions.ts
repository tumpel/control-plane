import { buildPushPayload } from "@block65/webcrypto-web-push";
import { type CreatePushSubscriptionInputSchema, PushSubscriptionSchema, TenantEventSchema } from "@tumpel/schemas";
import { v5 as uuidV5 } from "uuid";
import type { z } from "zod";
import { fromBase64, seal, unseal } from "./envelope.ts";
import { githubRepository } from "./github.ts";
import { pushNotification } from "./push-notification.ts";
import type { NewTenantEvent } from "./tenant-events.ts";
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

type PushWakeRow = {
  event_id: number;
  push_subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth_sealed: string;
  payload: string;
  event_created_at: number;
  repository: string;
  failures: number;
  next_attempt_at: number;
};

const PUSH_SUBSCRIPTION_SELECT = `SELECT p.push_subscription_id, p.principal_id, p.endpoint, p.created_at,
  (SELECT json_group_array(event) FROM (SELECT event FROM push_subscription_events
    WHERE push_subscription_id = p.push_subscription_id ORDER BY event)) AS events
  FROM push_subscriptions AS p`;
const PUSH_SUBSCRIPTION_NAMESPACE = uuidV5("tumpel:push-subscription", uuidV5.URL);

const authContext = (pushSubscriptionId: string): string => `push-subscription/${pushSubscriptionId}/auth`;

let loadedVapidPrivateKey: { pem: string; key: string } | undefined;

const vapidPrivateKey = async (pem: string): Promise<string> => {
  if (loadedVapidPrivateKey?.pem === pem) return loadedVapidPrivateKey.key;
  const body = pem.match(
    new RegExp(`^-----BEGIN ${"PRIVATE KEY"}-----\\s+([A-Za-z0-9+/=\\s]+)-----END ${"PRIVATE KEY"}-----\\s*$`),
  )?.[1];
  if (body === undefined)
    throw new Error("VAPID_PRIVATE_KEY is not a PKCS#8 PEM private key; replace the VAPID configuration");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(body.replaceAll(/\s/g, "")),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const exported = await crypto.subtle.exportKey("jwk", privateKey);
  if (exported instanceof ArrayBuffer || exported.d === undefined) {
    throw new Error("VAPID_PRIVATE_KEY does not hold a P-256 private key; replace the VAPID configuration");
  }
  loadedVapidPrivateKey = { pem, key: exported.d };
  return exported.d;
};

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

  protected async deliverPushes(tenantId: string, now: number): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<PushWakeRow>(
        `SELECT w.event_id, w.failures, w.next_attempt_at, p.push_subscription_id, p.endpoint, p.p256dh, p.auth_sealed,
          e.payload, e.created_at AS event_created_at, s.repository FROM push_wakes AS w
          JOIN push_subscriptions AS p USING (push_subscription_id)
          JOIN events AS e USING (event_id)
          JOIN event_sessions AS es USING (event_id)
          JOIN sessions AS s USING (session_id)
          WHERE NOT EXISTS (SELECT 1 FROM push_wakes AS earlier
            WHERE earlier.push_subscription_id = w.push_subscription_id AND earlier.event_id < w.event_id)
            AND w.next_attempt_at <= ?
          ORDER BY w.event_id, p.push_subscription_id`,
        now,
      )
      .toArray();
    if (rows.length === 0) return;
    const dataKey = await this.dataKey();
    const privateKey = await vapidPrivateKey(this.env.VAPID_PRIVATE_KEY);
    for (const row of rows) {
      const event = TenantEventSchema.parse({
        ...JSON.parse(row.payload),
        eventId: row.event_id,
        tenantId,
        createdAt: row.event_created_at,
      });
      if (event.event !== "SubscriptionPaused" && event.event !== "SubscriptionEnded") {
        throw new Error(`push wake ${row.event_id} holds unsupported event ${event.event}`);
      }
      const repository = githubRepository(row.repository);
      if (repository === null) throw new Error(`session repository ${row.repository} is not a GitHub repository`);
      const payload = await buildPushPayload(
        { data: pushNotification(event, repository.name), options: { ttl: 86_400 } },
        {
          endpoint: row.endpoint,
          expirationTime: null,
          keys: {
            p256dh: row.p256dh,
            auth: await unseal(
              dataKey,
              row.auth_sealed,
              authContext(row.push_subscription_id),
              "turn notifications off and on again for this browser",
            ),
          },
        },
        {
          privateKey,
          publicKey: this.env.VAPID_PUBLIC_KEY,
          subject: this.env.VAPID_SUBJECT,
        },
      );
      const signal = AbortSignal.timeout(10_000);
      const response = await fetch(row.endpoint, { ...payload, signal }).catch((error: unknown) =>
        signal.aborted ? "The push service did not answer within 10 seconds" : error,
      );
      if (response instanceof Response && (response.status === 404 || response.status === 410)) {
        const deleted = this.ctx.storage.sql.exec(
          "DELETE FROM push_subscriptions WHERE push_subscription_id = ? AND p256dh = ? AND auth_sealed = ?",
          row.push_subscription_id,
          row.p256dh,
          row.auth_sealed,
        ).rowsWritten;
        if (deleted === 0) {
          this.ctx.storage.sql.exec(
            "UPDATE push_wakes SET failures = 0, next_attempt_at = ? WHERE event_id = ? AND push_subscription_id = ?",
            now,
            row.event_id,
            row.push_subscription_id,
          );
        }
        continue;
      }
      if (!(response instanceof Response) || !response.ok) {
        const delay = Math.min(60_000 * 2 ** Math.min(row.failures, 6), 60 * 60 * 1000);
        this.ctx.storage.sql.exec(
          "UPDATE push_wakes SET failures = failures + 1, next_attempt_at = ? WHERE event_id = ? AND push_subscription_id = ?",
          now + delay,
          row.event_id,
          row.push_subscription_id,
        );
        continue;
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM push_wakes WHERE event_id = ? AND push_subscription_id = ?",
        row.event_id,
        row.push_subscription_id,
      );
    }
  }

  protected override appendEvent(event: NewTenantEvent, now: number): number {
    const eventId = super.appendEvent(event, now);
    if (event.event !== "SubscriptionPaused" && event.event !== "SubscriptionEnded") return eventId;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO push_wakes (event_id, push_subscription_id, failures, next_attempt_at)
        SELECT ?, push_subscription_id, 0, ? FROM push_subscription_events WHERE event = ?`,
      eventId,
      now,
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
