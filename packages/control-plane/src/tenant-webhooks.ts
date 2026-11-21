import {
  type CreateWebhookEndpointInputSchema,
  type WebhookDeliveryStatusSchema,
  WebhookEndpointSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { endOfLog, type NewTenantEvent } from "./tenant-events.ts";
import { TenantSubscriptions } from "./tenant-subscriptions.ts";

export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;
type WebhookEndpointCreate = z.infer<typeof CreateWebhookEndpointInputSchema>["endpoint"];
type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

type WebhookEndpointRow = {
  webhook_endpoint_id: string;
  url: string;
  start_event_id: number;
  created_at: number;
  status: string;
};

const WEBHOOK_ENDPOINT_SELECT = `SELECT w.webhook_endpoint_id, w.url, w.start_event_id, w.created_at,
  CASE WHEN f.webhook_endpoint_id IS NULL THEN json_object('delivery', 'Delivering')
    ELSE json_object('delivery', 'Failing', 'detail', f.detail, 'failingSince', f.failing_since) END AS status
  FROM webhook_endpoints AS w LEFT JOIN webhook_failings AS f USING (webhook_endpoint_id)`;

const toWebhookEndpoint = (sql: SqlStorage, tenantId: string, row: WebhookEndpointRow): WebhookEndpoint =>
  WebhookEndpointSchema.parse({
    webhookEndpointId: row.webhook_endpoint_id,
    tenantId,
    url: row.url,
    events: sql
      .exec<{ event: WebhookEndpoint["events"][number] }>(
        "SELECT event FROM webhook_endpoint_events WHERE webhook_endpoint_id = ? ORDER BY event",
        row.webhook_endpoint_id,
      )
      .toArray()
      .map(({ event }) => event),
    status: JSON.parse(row.status),
    createdAt: row.created_at,
  });

export abstract class TenantWebhooks extends TenantSubscriptions {
  private readonly webhookWakes = new Map<string, number>();

  protected listWebhookEndpoints(tenantId: string): WebhookEndpoint[] {
    const sql = this.ctx.storage.sql;
    return sql
      .exec<WebhookEndpointRow>(`${WEBHOOK_ENDPOINT_SELECT} ORDER BY w.created_at, w.webhook_endpoint_id`)
      .toArray()
      .map((row) => toWebhookEndpoint(sql, tenantId, row));
  }

  protected getWebhookEndpoint(tenantId: string, webhookEndpointId: string): WebhookEndpoint | null {
    const sql = this.ctx.storage.sql;
    const [row] = sql
      .exec<WebhookEndpointRow>(`${WEBHOOK_ENDPOINT_SELECT} WHERE w.webhook_endpoint_id = ?`, webhookEndpointId)
      .toArray();
    return row === undefined ? null : toWebhookEndpoint(sql, tenantId, row);
  }

  protected createWebhookEndpoint(tenantId: string, endpoint: WebhookEndpointCreate, now: number): WebhookEndpoint {
    const sql = this.ctx.storage.sql;
    const webhookEndpointId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT INTO webhook_endpoints (webhook_endpoint_id, url, start_event_id, created_at) VALUES (?, ?, ?, ?)",
        webhookEndpointId,
        endpoint.url,
        endOfLog(sql),
        now,
      );
      for (const event of new Set(endpoint.events)) {
        sql.exec(
          "INSERT INTO webhook_endpoint_events (webhook_endpoint_id, event) VALUES (?, ?)",
          webhookEndpointId,
          event,
        );
      }
    });
    const created = this.getWebhookEndpoint(tenantId, webhookEndpointId);
    if (created === null) throw new Error(`webhook endpoint ${webhookEndpointId} vanished while it was read back`);
    return created;
  }

  protected deleteWebhookEndpoint(webhookEndpointId: string): boolean {
    return (
      this.ctx.storage.sql.exec("DELETE FROM webhook_endpoints WHERE webhook_endpoint_id = ?", webhookEndpointId)
        .rowsWritten > 0
    );
  }

  protected setWebhookEndpointStatus(webhookEndpointId: string, status: WebhookDeliveryStatus): void {
    const sql = this.ctx.storage.sql;
    const [endpoint] = sql
      .exec("SELECT 1 FROM webhook_endpoints WHERE webhook_endpoint_id = ?", webhookEndpointId)
      .toArray();
    if (endpoint === undefined) return;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM webhook_failings WHERE webhook_endpoint_id = ?", webhookEndpointId);
      if (status.delivery === "Delivering") return;
      sql.exec(
        "INSERT INTO webhook_failings (webhook_endpoint_id, detail, failing_since) VALUES (?, ?, ?)",
        webhookEndpointId,
        status.detail,
        status.failingSince,
      );
    });
  }

  protected override appendEvent(event: NewTenantEvent, now: number): number {
    const eventId = super.appendEvent(event, now);
    const wakes = this.ctx.storage.sql
      .exec<{ webhook_endpoint_id: string; start_event_id: number }>(
        `SELECT w.webhook_endpoint_id, w.start_event_id FROM webhook_endpoints AS w
        JOIN webhook_endpoint_events AS e USING (webhook_endpoint_id) WHERE e.event = ? ORDER BY w.created_at, w.webhook_endpoint_id`,
        event.event,
      )
      .toArray();
    for (const wake of wakes) this.webhookWakes.set(wake.webhook_endpoint_id, wake.start_event_id);
    return eventId;
  }

  protected takeWebhookWakes(): { webhookEndpointId: string; cursorEventId: number }[] {
    const wakes = [...this.webhookWakes].map(([webhookEndpointId, cursorEventId]) => ({
      webhookEndpointId,
      cursorEventId,
    }));
    this.webhookWakes.clear();
    return wakes;
  }
}
