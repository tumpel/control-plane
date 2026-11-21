import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.ts";
import { tenantApi } from "./tenant-api.ts";

export type PushDelivery = {
  eventId: number;
  tenantId: string;
  principalId: string;
  pushSubscriptionId: string;
  endpoint: string;
  headers: [string, string][];
  body: Uint8Array<ArrayBuffer>;
};

const deliveryKey = (eventId: number): string => `delivery/${String(eventId).padStart(20, "0")}`;

export const pushSenderName = (tenantId: string, pushSubscriptionId: string): string =>
  `${tenantId}/${pushSubscriptionId}`;

export class PushSender extends DurableObject<Env> {
  private delivering: Promise<void> = Promise.resolve();

  async wake(delivery: PushDelivery): Promise<void> {
    await this.ctx.storage.put(deliveryKey(delivery.eventId), delivery);
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
    const deliveries = await this.ctx.storage.list<PushDelivery>({ prefix: "delivery/" });
    for (const [key, delivery] of deliveries) {
      const response = await fetch(delivery.endpoint, {
        method: "POST",
        headers: delivery.headers,
        body: delivery.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404 || response.status === 410) {
        await tenantApi(this.env.TENANT, delivery.tenantId).call("deletePushSubscription", {
          tenantId: delivery.tenantId,
          principalId: delivery.principalId,
          pushSubscriptionId: delivery.pushSubscriptionId,
        });
        await this.ctx.storage.deleteAll();
        return;
      }
      if (!response.ok) {
        throw new Error(
          `push service ${new URL(delivery.endpoint).origin} refused subscription ${delivery.pushSubscriptionId} with HTTP ${response.status}`,
        );
      }
      await this.ctx.storage.delete(key);
    }
  }
}
