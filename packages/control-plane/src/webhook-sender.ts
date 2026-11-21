import { DurableObject } from "cloudflare:workers";
import type { ListEventsResultSchema, TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { backoffMs, errorOf, RETRY_LIMIT, retryableStatus } from "./backoff.ts";
import type { Env } from "./index.ts";
import { keyStoreOf } from "./key-store.ts";
import { tenantApi } from "./tenant-api.ts";
import { signWebhook } from "./webhook-signing.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const FIRST_RETRY_MS = 60_000;

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
    const send = (): Promise<void> => this.sendPending(retry).catch((error: unknown) => this.crashed(error));
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
        await this.failed(
          state,
          `the endpoint fell behind event ${listed.oldestEventId}, which the event log no longer keeps`,
          false,
        );
        return;
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
          await this.failed(state, detail, !(response instanceof Response) || retryableStatus(response.status));
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

  private async crashed(error: unknown): Promise<void> {
    const state = await this.ctx.storage.get<SenderState>("state");
    if (state === undefined) throw error;
    await this.failed(state, errorOf(error).message, true);
  }

  private async failed(state: SenderState, detail: string, retryable: boolean): Promise<void> {
    const now = Date.now();
    const failure = await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<Failure>("failure");
      const next = { failures: (stored?.failures ?? 0) + 1, failingSince: stored?.failingSince ?? now };
      if (!retryable || next.failures > RETRY_LIMIT) return next;
      await transaction.put("failure", next);
      await transaction.setAlarm(now + backoffMs(next.failures, FIRST_RETRY_MS));
      return null;
    });
    if (failure === null) return;
    await tenantApi(this.env.TENANT, state.tenantId).call("setWebhookEndpointStatus", {
      tenantId: state.tenantId,
      webhookEndpointId: state.webhookEndpointId,
      status: {
        delivery: "Failing",
        detail: retryable
          ? `${detail}; still failing after ${RETRY_LIMIT} retries`
          : `${detail}; retrying cannot fix this`,
        failingSince: new Date(failure.failingSince).toISOString(),
      },
    });
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete("failure");
      await transaction.deleteAlarm();
    });
  }
}
