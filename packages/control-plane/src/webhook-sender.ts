import { DurableObject } from "cloudflare:workers";
import type { ListEventsResultSchema, TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { Env } from "./index.ts";
import { keyStoreOf } from "./key-store.ts";
import { tenantApi } from "./tenant-api.ts";
import { signWebhook } from "./webhook-signing.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const FAILING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

type SenderState = {
  tenantId: string;
  webhookEndpointId: string;
  cursorEventId: number;
  generation: number;
};

type Failure = {
  failures: number;
  failingSince: number;
};

type Wake = { tenantId: string; webhookEndpointId: string; cursorEventId: number };
type Listed = z.infer<typeof ListEventsResultSchema>["listed"];
type TenantEvent = z.infer<typeof TenantEventSchema>;

export const webhookSenderName = (tenantId: string, webhookEndpointId: string): string =>
  `${tenantId}/${webhookEndpointId}`;

export class WebhookSender extends DurableObject<Env> {
  private delivering: Promise<void> = Promise.resolve();

  async wake(input: Wake): Promise<void> {
    const retrying = await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<SenderState>("state");
      const state: SenderState =
        stored === undefined
          ? {
              tenantId: input.tenantId,
              webhookEndpointId: input.webhookEndpointId,
              cursorEventId: input.cursorEventId,
              generation: 1,
            }
          : { ...stored, generation: stored.generation + 1 };
      await transaction.put("state", state);
      const failure = await transaction.get<Failure>("failure");
      if (failure === undefined) await transaction.setAlarm(Date.now() + FIRST_RETRY_MS);
      return failure !== undefined;
    });
    if (retrying) return;
    this.ctx.waitUntil(this.deliver(false));
  }

  async stop(): Promise<void> {
    await this.delivering;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.deliver(true);
  }

  private deliver(retry: boolean): Promise<void> {
    const send = (): Promise<void> => this.sendPending(retry);
    this.delivering = this.delivering.then(send, send);
    return this.delivering;
  }

  private async sendPending(retry: boolean): Promise<void> {
    let state = await this.ctx.storage.get<SenderState>("state");
    if (state === undefined) return;
    if (!retry && (await this.ctx.storage.get<Failure>("failure")) !== undefined) return;
    const generation = state.generation;
    const tenant = tenantApi(this.env.TENANT, state.tenantId);
    const { endpoint } = await tenant.call("getWebhookEndpoint", {
      tenantId: state.tenantId,
      webhookEndpointId: state.webhookEndpointId,
    });
    if (endpoint === null || endpoint.status.delivery === "Failing") {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete("failure");
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
          await this.failed(state, detail);
          return;
        }
        await this.ctx.storage.delete("failure");
        state = await this.advanceCursor(event.eventId);
      }
      state = await this.advanceCursor(listed.page.lastEventId);
      if (listed.page.events.length < 100) {
        await this.ctx.storage.transaction(async (transaction) => {
          const current = await transaction.get<SenderState>("state");
          if (current?.generation === generation) await transaction.deleteAlarm();
        });
        return;
      }
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

  private async failed(state: SenderState, detail: string): Promise<void> {
    const now = Date.now();
    const failure = await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<Failure>("failure");
      const failingSince = stored?.failingSince ?? now;
      const failures = (stored?.failures ?? 0) + 1;
      const next = { failures, failingSince };
      await transaction.put("failure", next);
      if (now - failingSince < FAILING_AFTER_MS) {
        const delay = Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
        await transaction.setAlarm(Math.min(now + delay, failingSince + FAILING_AFTER_MS));
      }
      return next;
    });
    const { failingSince } = failure;
    if (now - failingSince >= FAILING_AFTER_MS) {
      await tenantApi(this.env.TENANT, state.tenantId).call("setWebhookEndpointStatus", {
        tenantId: state.tenantId,
        webhookEndpointId: state.webhookEndpointId,
        status: { delivery: "Failing", detail, failingSince: new Date(failingSince).toISOString() },
      });
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.delete("failure");
        await transaction.deleteAlarm();
      });
      return;
    }
  }
}
