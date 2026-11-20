import { DurableObject } from "cloudflare:workers";
import type { TenantEventSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { Env } from "./index.ts";
import { pushNotification, pushSessionName } from "./push-notification.ts";
import { tenantApi } from "./tenant-api.ts";
import { pushRequest } from "./web-push.ts";

type TenantEvent = z.infer<typeof TenantEventSchema>;
type State = { tenantId: string; pushSubscriptionId: string; cursor: number };

const STATE_KEY = "state";

export class PushSender extends DurableObject<Env> {
  private delivery: Promise<void> | null = null;
  private pending = false;

  async start(tenantId: string, pushSubscriptionId: string, cursor: number): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, { tenantId, pushSubscriptionId, cursor });
  }

  async drop(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async wake(): Promise<void> {
    if (this.delivery !== null) {
      this.pending = true;
      return this.delivery;
    }
    this.delivery = this.drain().finally(() => {
      this.delivery = null;
    });
    return this.delivery;
  }

  private async drain(): Promise<void> {
    do {
      this.pending = false;
      await this.deliver();
    } while (this.pending);
  }

  private async deliver(): Promise<void> {
    const state = await this.ctx.storage.get<State>(STATE_KEY);
    if (state === undefined) return;
    const tenant = tenantApi(this.env.TENANT, state.tenantId);
    const { target } = await tenant.call("pushTarget", state);
    if (target === null) return this.drop();
    let cursor = state.cursor;
    while (true) {
      const { listed } = await tenant.call("listEvents", {
        tenantId: state.tenantId,
        afterEventId: cursor,
        events: target.events,
        sessionId: null,
        triggerId: null,
        waitSeconds: 0,
      });
      if (listed.kind === "CursorExpired") {
        cursor = listed.oldestEventId - 1;
        continue;
      }
      for (const event of listed.page.events) {
        const response = await fetch(
          await pushRequest(
            target.endpoint,
            JSON.stringify(pushNotification(event, await this.sessionName(tenant, event))),
            target.keys.p256dh,
            target.keys.auth,
            this.env.VAPID_PRIVATE_KEY,
            this.env.API_ORIGIN,
            Date.now(),
          ),
        );
        if (response.status === 404 || response.status === 410) {
          await tenant.call("forgetPushSubscription", state);
          return this.drop();
        }
        if (!response.ok) {
          throw new Error(
            `push service ${new URL(target.endpoint).origin} refused subscription ${state.pushSubscriptionId} with ${response.status}; turn notifications off and on again if it continues`,
          );
        }
        cursor = event.eventId;
        await this.ctx.storage.put(STATE_KEY, { ...state, cursor });
      }
      cursor = listed.page.lastEventId;
      await this.ctx.storage.put(STATE_KEY, { ...state, cursor });
      if (listed.page.events.length < 100) return;
    }
  }

  private async sessionName(tenant: ReturnType<typeof tenantApi>, event: TenantEvent): Promise<string | null> {
    if (!("sessionId" in event)) return null;
    const { session } = await tenant.call("getSession", { tenantId: event.tenantId, sessionId: event.sessionId });
    return session === null ? null : pushSessionName(session.repository);
  }
}
