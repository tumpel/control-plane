import { DurableObject } from "cloudflare:workers";
import type { ListEventsResultSchema, TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { Env } from "./index.ts";
import { keyStoreOf } from "./key-store.ts";
import { tenantApi } from "./tenant-api.ts";
import { signWebhook } from "./webhook-signing.ts";

const REQUEST_TIMEOUT_MS = 10_000;

type SenderState = {
  tenantId: string;
  webhookEndpointId: string;
  cursorEventId: number;
};

type Wake = { tenantId: string; webhookEndpointId: string; cursorEventId: number };
type Listed = z.infer<typeof ListEventsResultSchema>["listed"];
type TenantEvent = z.infer<typeof TenantEventSchema>;

export const webhookSenderName = (tenantId: string, webhookEndpointId: string): string =>
  `${tenantId}/${webhookEndpointId}`;

export class WebhookSender extends DurableObject<Env> {
  private delivering: Promise<void> = Promise.resolve();

  async wake(input: Wake): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<SenderState>("state");
      if (stored !== undefined) return;
      await transaction.put("state", {
        tenantId: input.tenantId,
        webhookEndpointId: input.webhookEndpointId,
        cursorEventId: input.cursorEventId,
      } satisfies SenderState);
    });
    this.ctx.waitUntil(this.deliver());
  }

  async stop(): Promise<void> {
    await this.delivering;
    await this.ctx.storage.deleteAll();
  }

  private deliver(): Promise<void> {
    const send = (): Promise<void> => this.sendPending();
    this.delivering = this.delivering.then(send, send);
    return this.delivering;
  }

  private async sendPending(): Promise<void> {
    let state = await this.ctx.storage.get<SenderState>("state");
    if (state === undefined) return;
    const tenant = tenantApi(this.env.TENANT, state.tenantId);
    const { endpoint } = await tenant.call("getWebhookEndpoint", {
      tenantId: state.tenantId,
      webhookEndpointId: state.webhookEndpointId,
    });
    if (endpoint === null || endpoint.status.delivery === "Failing") {
      if (endpoint === null) await this.ctx.storage.deleteAll();
      return;
    }
    for (;;) {
      const result: { listed: Listed } = await tenant.call("listEvents", {
        tenantId: state.tenantId,
        afterEventId: state.cursorEventId,
        events: endpoint.events,
        sessionId: null,
        triggerId: null,
        waitSeconds: 0,
      });
      const listed: Listed = result.listed;
      if (listed.kind === "CursorExpired") {
        throw new Error(
          `webhook endpoint ${state.webhookEndpointId} fell behind event ${listed.oldestEventId} before its three-day failure window ended`,
        );
      }
      const events: TenantEvent[] = listed.page.events;
      for (const event of events) {
        const body = JSON.stringify(event);
        const signature = await signWebhook(keyStoreOf(this.env), state.tenantId, body);
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "tumpel-event-id": String(event.eventId),
            "tumpel-signature": signature,
          },
          body,
          signal,
        }).catch((error: unknown) => (signal.aborted ? "The endpoint did not answer within 10 seconds" : error));
        if (!(response instanceof Response) || response.status < 200 || response.status >= 300) {
          const detail =
            response instanceof Response
              ? `HTTP ${response.status}`
              : response instanceof Error
                ? response.message
                : String(response);
          console.error(
            `WebhookDeliveryFailed: webhook endpoint ${state.webhookEndpointId} of tenant ${state.tenantId} did not take event ${event.eventId}: ${detail}`,
          );
          return;
        }
        state = await this.advanceCursor(event.eventId);
      }
      state = await this.advanceCursor(listed.page.lastEventId);
      if (listed.page.events.length < 100) return;
    }
  }

  private advanceCursor(cursorEventId: number): Promise<SenderState> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await transaction.get<SenderState>("state");
      if (state === undefined) throw new Error("the webhook sender lost its state while advancing its cursor");
      const advanced = { ...state, cursorEventId };
      await transaction.put("state", advanced);
      return advanced;
    });
  }
}
