import type { DeadlineMessage } from "../../src/deadlines";
import worker, { Tenant as BaseTenant, type Env } from "../../src/index";

export { EventChannel, HostChannel, TenantMetrics, WebhookSender } from "../../src/index";

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

const deadlines = async (request: Request, env: Env): Promise<Response> => {
  await env.DEADLINES.send(await request.json<DeadlineMessage>());
  return new Response(null, { status: 204 });
};

const sql = async (request: Request, env: Env, tenantId: string): Promise<Response> => {
  const tenant = (env.TENANT as unknown as DurableObjectNamespace<Tenant>).getByName(tenantId);
  const { query, bindings } = await request.json<{ query: string; bindings: SqlStorageValue[] }>();
  return Response.json(await tenant.sql(query, bindings));
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
  if (kind === "deadlines") return deadlines(request, env);
  if (kind === "sql") return sql(request, env, target);
  if (kind === "d1") return d1(request, env);
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
