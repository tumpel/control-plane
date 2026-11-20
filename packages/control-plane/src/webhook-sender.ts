import { DurableObject } from "cloudflare:workers";
import type { ListEventsResultSchema, TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { Env } from "./index.ts";
import { keyStoreOf } from "./key-store.ts";
import { tenantApi } from "./tenant-api.ts";
import { webhookRetryDelay } from "./webhook-retry.ts";
import { signWebhook } from "./webhook-signing.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const FAILING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

type SenderState = {
  tenantId: string;
  webhookEndpointId: string;
  cursorEventId: number;
  failures: number;
  failingSince: number | null;
};

type Wake = { tenantId: string; webhookEndpointId: string; cursorEventId: number };
type Listed = z.infer<typeof ListEventsResultSchema>["listed"];
type TenantEvent = z.infer<typeof TenantEventSchema>;

export const webhookSenderName = (tenantId: string, webhookEndpointId: string): string =>
  `${tenantId}/${webhookEndpointId}`;

export class WebhookSender extends DurableObject<Env> {
  private delivering: Promise<void> = Promise.resolve();

  async wake(input: Wake): Promise<void> {
    const stored = await this.ctx.storage.get<SenderState>("state");
    if (stored === undefined) {
      await this.ctx.storage.put<SenderState>("state", {
        tenantId: input.tenantId,
        webhookEndpointId: input.webhookEndpointId,
        cursorEventId: input.cursorEventId,
        failures: 0,
        failingSince: null,
      });
    }
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.deliver();
  }

  async stop(): Promise<void> {
    await this.delivering;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.deliver();
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
      await this.ctx.storage.deleteAlarm();
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
        }).catch(() => null);
        if (response === null || response.status < 200 || response.status >= 300) {
          const detail =
            response === null ? "The endpoint did not answer within 10 seconds" : `HTTP ${response.status}`;
          await this.failed(state, detail);
          return;
        }
        state = { ...state, cursorEventId: event.eventId, failures: 0, failingSince: null };
        await this.ctx.storage.put("state", state);
      }
      state = { ...state, cursorEventId: listed.page.lastEventId };
      await this.ctx.storage.put("state", state);
      if (listed.page.events.length < 100) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
    }
  }

  private async failed(state: SenderState, detail: string): Promise<void> {
    const now = Date.now();
    const failingSince = state.failingSince ?? now;
    const failures = state.failures + 1;
    await this.ctx.storage.put("state", { ...state, failures, failingSince });
    if (now - failingSince >= FAILING_AFTER_MS) {
      await tenantApi(this.env.TENANT, state.tenantId).call("setWebhookEndpointStatus", {
        tenantId: state.tenantId,
        webhookEndpointId: state.webhookEndpointId,
        status: { delivery: "Failing", detail, failingSince: new Date(failingSince).toISOString() },
      });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(now + webhookRetryDelay(failures), failingSince + FAILING_AFTER_MS));
  }
}
