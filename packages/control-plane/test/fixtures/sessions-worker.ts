import { HostLedger } from "../../src/channel/ledger";
import { durableDb } from "../../src/db/client";
import * as hostSchema from "../../src/db/host-schema";
import worker, { HostChannel as BaseHostChannel, Tenant as BaseTenant, type Env } from "../../src/index";
import { meteredState } from "../../src/metered-state";
import { tenantApi } from "../../src/tenant-api";
import type { Rows } from "../../src/usage-meter";

export { EventChannel, TenantMetrics, WebhookSender } from "../../src/index";

export class HostChannel extends BaseHostChannel {
  private readonly cursors: Rows[];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cursors = [];
    this.ctx = meteredState(this.ctx, this.cursors);
    Reflect.set(this, "ledger", new HostLedger(durableDb(this.ctx.storage, hostSchema)));
  }

  rows(): Rows {
    return {
      rowsRead: this.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      rowsWritten: this.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    };
  }
}

export class Tenant extends BaseTenant {
  sql(query: string, bindings: SqlStorageValue[]): Record<string, SqlStorageValue>[] {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }
}

const FIXTURE = "/__fixture/";

const bucket = (env: Env, name: string): R2Bucket | null => {
  if (name === "STORE") return env.STORE;
  if (name === "RELEASES") return env.RELEASES;
  return null;
};

const objects = async (request: Request, env: Env, path: string): Promise<Response> => {
  const slash = path.indexOf("/");
  const store = bucket(env, path.slice(0, slash));
  if (store === null) return new Response(`no bucket in ${path}`, { status: 404 });
  const key = path.slice(slash + 1);
  if (request.method === "PUT") {
    await store.put(key, await request.arrayBuffer());
    return new Response(null, { status: 204 });
  }
  if (request.method === "DELETE") {
    await store.delete(key);
    return new Response(null, { status: 204 });
  }
  const object = await store.get(key);
  if (object === null) return new Response(null, { status: 404 });
  return new Response(object.body);
};

const sql = async (request: Request, env: Env, tenantId: string): Promise<Response> => {
  const tenant = (env.TENANT as unknown as DurableObjectNamespace<Tenant>).getByName(tenantId);
  const { query, bindings } = await request.json<{ query: string; bindings: SqlStorageValue[] }>();
  return Response.json(await tenant.sql(query, bindings));
};

const usage = async (env: Env, tenantId: string): Promise<Response> =>
  Response.json(await tenantApi(env.TENANT, tenantId).call("readUsage", { tenantId }));

const hostRows = async (env: Env, hostId: string): Promise<Response> => {
  const host = (env.HOST as unknown as DurableObjectNamespace<HostChannel>).getByName(hostId);
  return Response.json(await host.rows());
};

const d1 = async (request: Request, env: Env): Promise<Response> => {
  const { query, bindings } = await request.json<{ query: string; bindings: unknown[] }>();
  await env.DB.prepare(query)
    .bind(...bindings)
    .run();
  return new Response(null, { status: 204 });
};

const fixture = (request: Request, env: Env, path: string): Promise<Response> => {
  const [kind = "", ...rest] = path.split("/");
  const target = rest.join("/");
  if (kind === "objects") return objects(request, env, target);
  if (kind === "sql") return sql(request, env, target);
  if (kind === "d1") return d1(request, env);
  if (kind === "usage") return usage(env, target);
  if (kind === "host-rows") return hostRows(env, target);
  return Promise.resolve(new Response(`no fixture route ${path}`, { status: 404 }));
};

export default {
  ...worker,
  fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(FIXTURE)) return fixture(request, env, pathname.slice(FIXTURE.length));
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
