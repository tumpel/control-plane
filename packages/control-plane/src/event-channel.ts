import { DurableObject } from "cloudflare:workers";
import { EventCursorExpiredProblemSchema, TenantEventTypeSchema } from "@tumpel/schemas";
import { z } from "zod";
import { json } from "./http.ts";
import type { Env } from "./index.ts";
import { tenantApi } from "./tenant-api.ts";
import type { NewTenantEvent } from "./tenant-events.ts";

const SubscriptionSchema = z.object({
  tenantId: z.string(),
  cursor: z.int(),
  events: z.array(TenantEventTypeSchema),
  sessionId: z.string().nullable(),
  triggerId: z.string().nullable().default(null),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

const PAGE_SIZE = 100;

export const channelUrl = (subscription: Subscription): string => {
  const url = new URL("https://event-channel/");
  url.searchParams.set("subscription", JSON.stringify(subscription));
  return url.toString();
};

export const matches = (subscription: Subscription, event: NewTenantEvent): boolean =>
  (subscription.events.length === 0 || subscription.events.includes(event.event)) &&
  (subscription.sessionId === null || ("sessionId" in event && event.sessionId === subscription.sessionId)) &&
  (subscription.triggerId === null || ("triggerId" in event && event.triggerId === subscription.triggerId));

export const eventCursorExpired = (afterEventId: number, oldestEventId: number): Response =>
  json(
    EventCursorExpiredProblemSchema.parse({
      code: "EventCursorExpired",
      title: "Event cursor expired",
      detail: `event ${afterEventId} is older than the oldest event kept, ${oldestEventId}; the log keeps 7 days`,
      fix: "Read the current state of what you follow, then read events again without afterEventId",
      oldestEventId,
    }),
    410,
  );

export class EventChannel extends DurableObject<Env> {
  private delivering: Promise<void> = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new Error("the event channel answers WebSocket upgrades only, which the Worker sends");
    }
    const subscription = SubscriptionSchema.parse(
      JSON.parse(new URL(request.url).searchParams.get("subscription") ?? "null"),
    );
    const { listed } = await tenantApi(this.env.TENANT, subscription.tenantId).call("listEvents", {
      tenantId: subscription.tenantId,
      afterEventId: subscription.cursor,
      events: subscription.events,
      sessionId: subscription.sessionId,
      triggerId: subscription.triggerId,
    });
    if (listed.kind === "CursorExpired") return eventCursorExpired(subscription.cursor, listed.oldestEventId);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    for (const event of listed.page.events) server.send(JSON.stringify(event));
    subscription.cursor = Math.max(subscription.cursor, listed.page.lastEventId);
    server.serializeAttachment(subscription);
    await this.deliver();
    return new Response(null, { status: 101, webSocket: client });
  }

  async wake(): Promise<void> {
    await this.deliver();
  }

  override webSocketMessage(socket: WebSocket): void {
    socket.close(1003, "the event channel sends events and takes no messages");
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  private deliver(): Promise<void> {
    const send = (): Promise<void> => this.sendPending();
    this.delivering = this.delivering.then(send, send);
    return this.delivering;
  }

  private async sendPending(): Promise<void> {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.READY_STATE_OPEN);
    const subscriptions = sockets.map((socket) => SubscriptionSchema.parse(socket.deserializeAttachment()));
    const [first] = subscriptions;
    if (first === undefined) return;
    let cursor = Math.min(...subscriptions.map((subscription) => subscription.cursor));
    for (;;) {
      const { listed } = await tenantApi(this.env.TENANT, first.tenantId).call("listEvents", {
        tenantId: first.tenantId,
        afterEventId: cursor,
        events: [],
        sessionId: null,
        triggerId: null,
      });
      if (listed.kind === "CursorExpired") {
        throw new Error(
          `an event channel subscriber of tenant ${first.tenantId} fell behind event ${listed.oldestEventId}, which never happens while each wake moves every cursor to the end`,
        );
      }
      sockets.forEach((socket, index) => {
        const subscription = subscriptions[index];
        if (subscription === undefined) return;
        for (const event of listed.page.events) {
          if (event.eventId > subscription.cursor && matches(subscription, event)) socket.send(JSON.stringify(event));
        }
        subscription.cursor = Math.max(subscription.cursor, listed.page.lastEventId);
        socket.serializeAttachment(subscription);
      });
      cursor = listed.page.lastEventId;
      if (listed.page.events.length < PAGE_SIZE) return;
    }
  }
}
