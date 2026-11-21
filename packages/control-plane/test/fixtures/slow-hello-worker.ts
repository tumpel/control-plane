import worker, { type Env } from "../../src/index";
import { Tenant as BaseTenant } from "../../src/tenant";
import { TenantMetrics as BaseTenantMetrics } from "../../src/tenant-metrics";

export { EventChannel, HostChannel, PushSender, SessionTimer, WebhookSender } from "../../src/index";

export class Tenant extends BaseTenant {
  override async hostHello(...args: Parameters<BaseTenant["hostHello"]>): Promise<void> {
    await scheduler.wait(500);
    super.hostHello(...args);
  }
}

export class TenantMetrics extends BaseTenantMetrics {
  series(): Record<string, SqlStorageValue>[] {
    return this.ctx.storage.sql.exec("SELECT metric, dimensions FROM series").toArray();
  }
}

const METRICS_FIXTURE = /^\/__fixture\/metrics\/([^/]+)$/;

export default {
  ...worker,
  async fetch(request, env): Promise<Response> {
    const tenantId = METRICS_FIXTURE.exec(new URL(request.url).pathname)?.[1];
    if (tenantId === undefined) return worker.fetch(request, env);
    const metrics = (env.TENANT_METRICS as unknown as DurableObjectNamespace<TenantMetrics>).getByName(tenantId);
    return Response.json(await metrics.series());
  },
} satisfies ExportedHandler<Env>;
