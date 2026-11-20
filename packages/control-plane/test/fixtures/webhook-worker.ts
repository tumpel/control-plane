import { TenantApiProtocol } from "@tumpel/schemas";
import worker, { Tenant as BaseTenant, WebhookSender as BaseWebhookSender, type Env } from "../../src/index.ts";
import type { NewTenantEvent } from "../../src/tenant-events.ts";
import { webhookSenderName } from "../../src/webhook-sender.ts";

export { EventChannel, HostChannel, SessionTimer, TenantMetrics } from "../../src/index.ts";

export class Tenant extends BaseTenant {
  async emit(event: NewTenantEvent, now: number): Promise<void> {
    if ("sessionId" in event) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO sessions
          (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version,
            model, state, last_line_seq, endpoint, created_at, updated_at)
          VALUES (?, 'principal', 'host', 'box', 'persona', 'repository', 'codex', '1', 'model', 'Idle', 0, '', ?, ?)`,
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
