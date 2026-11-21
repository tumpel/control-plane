import { TenantApiProtocol } from "@tumpel/schemas";
import worker, { Tenant as BaseTenant, WebhookSender as BaseWebhookSender, type Env } from "../../src/index.ts";
import type { NewTenantEvent } from "../../src/tenant-events.ts";
import { webhookSenderName } from "../../src/webhook-sender.ts";

export { EventChannel, HostChannel, SessionTimer, TenantMetrics } from "../../src/index.ts";

export class Tenant extends BaseTenant {
  createFixtureSubscription(sessionId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions
        (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version,
          model, state, last_line_seq, endpoint, created_at, updated_at)
      VALUES (?, 'principal', 'host', 'box', 'persona', 'https://github.com/tumpel/control-plane.git',
        'codex', '1', 'model', 'Idle', 0, '', ?, ?)`,
      sessionId,
      now,
      now,
    );
    const created = this.createSubscription(
      this.ctx.id.name ?? "",
      {
        sessionId,
        prompt: "Handle matching events.",
        goal: "Finish handling the events.",
        expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
        events: ["SessionIdle"],
        crewTags: [],
      },
      now,
    );
    if (created.kind !== "Created") throw new Error(`fixture subscription was ${created.kind}`);
  }

  async emit(event: NewTenantEvent, now: number): Promise<void> {
    if ("sessionId" in event) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO sessions
          (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version,
            model, state, last_line_seq, endpoint, created_at, updated_at)
          VALUES (?, 'principal', 'host', 'box', 'persona', 'https://github.com/tumpel/control-plane.git',
            'codex', '1', 'model', 'Idle', 0, '', ?, ?)`,
        event.sessionId,
        now,
        now,
      );
    }
    this.appendEvent(event, now);
    await this.handle({
      tenantApiVersion: TenantApiProtocol.Version,
      operation: "listEvents",
      input: {
        tenantId: this.ctx.id.name,
        afterEventId: null,
        events: [],
        sessionId: null,
        triggerId: null,
        waitSeconds: 0,
      },
    });
  }

  pushWakes(): Record<string, SqlStorageValue>[] {
    return this.ctx.storage.sql
      .exec("SELECT push_subscription_id, failures, next_attempt_at FROM push_wakes ORDER BY push_subscription_id")
      .toArray();
  }

  corruptPushKey(endpoint: string): void {
    this.ctx.storage.sql.exec("UPDATE push_subscriptions SET p256dh = ? WHERE endpoint = ?", "A".repeat(87), endpoint);
  }

  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }
}

export class WebhookSender extends BaseWebhookSender {
  state(): Promise<unknown> {
    return this.ctx.storage.get("state");
  }

  failure(): Promise<unknown> {
    return this.ctx.storage.get("failure");
  }

  alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async failSince(at: number): Promise<void> {
    const failure = await this.ctx.storage.get<Record<string, unknown>>("failure");
    if (failure === undefined) throw new Error("the webhook sender has no failure");
    await this.ctx.storage.put("failure", { ...failure, failingSince: at });
  }

  runAlarm(): Promise<void> {
    return super.alarm();
  }
}

const requestBody = <T>(request: Request): Promise<T> => request.json<T>();

const tenant = (env: Env, tenantId: string): DurableObjectStub<Tenant> =>
  (env.TENANT as unknown as DurableObjectNamespace<Tenant>).getByName(tenantId);

const sender = (env: Env, tenantId: string, webhookEndpointId: string): DurableObjectStub<WebhookSender> =>
  (env.WEBHOOKS as unknown as DurableObjectNamespace<WebhookSender>).getByName(
    webhookSenderName(tenantId, webhookEndpointId),
  );

export default {
  ...worker,
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__fixture/") && request.headers.get("content-type") === "application/json") {
      const { tenantId } = await request.clone().json<{ tenantId?: string }>();
      if (tenantId !== undefined)
        await env.DB.prepare(
          "INSERT OR IGNORE INTO tenants (tenant_id, name, created_at, updated_at) VALUES (?, ?, 0, 0)",
        )
          .bind(tenantId, tenantId)
          .run();
    }
    if (url.pathname === "/__fixture/create") {
      const { tenantId, endpoint, now } = await requestBody<{
        tenantId: string;
        endpoint: { url: string; events: NewTenantEvent["event"][] };
        now: number;
      }>(request);
      return Response.json(
        await tenant(env, tenantId).handle({
          tenantApiVersion: TenantApiProtocol.Version,
          operation: "createWebhookEndpoint",
          input: { tenantId, endpoint, now },
        }),
      );
    }
    if (url.pathname === "/__fixture/emit") {
      const { tenantId, event, now } = await requestBody<{
        tenantId: string;
        event: NewTenantEvent;
        now: number;
      }>(request);
      await tenant(env, tenantId).emit(event, now);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__fixture/push/create") {
      const { tenantId, subscription, now } = await requestBody<{
        tenantId: string;
        subscription: { endpoint: string; keys: { p256dh: string; auth: string }; events: NewTenantEvent["event"][] };
        now: number;
      }>(request);
      return Response.json(
        await tenant(env, tenantId).handle({
          tenantApiVersion: TenantApiProtocol.Version,
          operation: "createPushSubscription",
          input: { tenantId, principalId: "principal", subscription, now },
        }),
      );
    }
    if (url.pathname === "/__fixture/push/list") {
      const { tenantId } = await requestBody<{ tenantId: string }>(request);
      return Response.json(
        await tenant(env, tenantId).handle({
          tenantApiVersion: TenantApiProtocol.Version,
          operation: "listPushSubscriptions",
          input: { tenantId, principalId: "principal" },
        }),
      );
    }
    if (url.pathname === "/__fixture/push/wakes") {
      const { tenantId } = await requestBody<{ tenantId: string }>(request);
      return Response.json(await tenant(env, tenantId).pushWakes());
    }
    if (url.pathname === "/__fixture/push/corrupt-key") {
      const { tenantId, endpoint } = await requestBody<{ tenantId: string; endpoint: string }>(request);
      await tenant(env, tenantId).corruptPushKey(endpoint);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__fixture/push/alarm-at") {
      const { tenantId } = await requestBody<{ tenantId: string }>(request);
      return Response.json({ alarmAt: await tenant(env, tenantId).alarmAt() });
    }
    if (url.pathname === "/__fixture/subscription/create") {
      const { tenantId, sessionId, now } = await requestBody<{ tenantId: string; sessionId: string; now: number }>(
        request,
      );
      await tenant(env, tenantId).createFixtureSubscription(sessionId, now);
      return new Response(null, { status: 204 });
    }
    const senderMatch = /^\/__fixture\/sender\/([^/]+)\/([^/]+)(\/fail-since|\/alarm)?$/.exec(url.pathname);
    if (senderMatch !== null) {
      const tenantId = decodeURIComponent(senderMatch[1] ?? "");
      const endpointId = decodeURIComponent(senderMatch[2] ?? "");
      const stub = sender(env, tenantId, endpointId);
      if (senderMatch[3] === "/fail-since") {
        await stub.failSince((await requestBody<{ at: number }>(request)).at);
        return new Response(null, { status: 204 });
      }
      if (senderMatch[3] === "/alarm") {
        await stub.runAlarm();
        return new Response(null, { status: 204 });
      }
      return Response.json({
        state: (await stub.state()) ?? null,
        failure: (await stub.failure()) ?? null,
        alarmAt: await stub.alarmAt(),
      });
    }
    if (url.pathname === "/__fixture/endpoint") {
      const tenantId = url.searchParams.get("tenantId") ?? "";
      const webhookEndpointId = url.searchParams.get("webhookEndpointId") ?? "";
      return Response.json(
        await tenant(env, tenantId).handle({
          tenantApiVersion: TenantApiProtocol.Version,
          operation: "getWebhookEndpoint",
          input: { tenantId, webhookEndpointId },
        }),
      );
    }
    if (url.pathname === "/__fixture/delete") {
      const { tenantId, webhookEndpointId } = await requestBody<{
        tenantId: string;
        webhookEndpointId: string;
      }>(request);
      const result = await tenant(env, tenantId).handle({
        tenantApiVersion: TenantApiProtocol.Version,
        operation: "deleteWebhookEndpoint",
        input: { tenantId, webhookEndpointId },
      });
      await sender(env, tenantId, webhookEndpointId).stop();
      return Response.json(result);
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
