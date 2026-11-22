import worker, { type Env } from "../../src/index";
import { Tenant as BaseTenant } from "../../src/tenant";
import { TenantMetrics as BaseTenantMetrics } from "../../src/tenant-metrics";

export { EventChannel, HostChannel, WebhookSender } from "../../src/index";

export class Tenant extends BaseTenant {
  override async hostHello(...args: Parameters<BaseTenant["hostHello"]>): Promise<void> {
    await scheduler.wait(500);
    super.hostHello(...args);
  }
}

export class TenantMetrics extends BaseTenantMetrics {
  private readonly written: AnalyticsEngineDataPoint[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    const written: AnalyticsEngineDataPoint[] = [];
    super(ctx, { ...env, METRICS: { writeDataPoint: (point) => written.push(point ?? {}) } });
    this.written = written;
  }

  series(): { metric: unknown; dimensions: unknown }[] {
    return this.written.map(({ blobs }) => ({ metric: blobs?.[0], dimensions: blobs?.[1] }));
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
