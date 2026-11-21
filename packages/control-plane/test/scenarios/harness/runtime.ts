import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mock } from "node:test";

type Row = Record<string, unknown>;

class Cursor {
  private readonly rows: Row[];
  readonly rowsWritten: number;

  constructor(rows: Row[], rowsWritten: number) {
    this.rows = rows;
    this.rowsWritten = rowsWritten;
  }

  toArray(): Row[] {
    return this.rows;
  }

  one(): Row {
    const [row] = this.rows;
    if (row === undefined || this.rows.length > 1) throw new Error(`expected one row, got ${this.rows.length}`);
    return row;
  }

  raw(): unknown[][] {
    return this.rows.map((row) => Object.values(row));
  }

  [Symbol.iterator](): Iterator<Row> {
    return this.rows[Symbol.iterator]();
  }
}

const statements = (query: string): number => query.trim().replace(/;$/, "").split(";").length;

const bindable = (value: unknown): SQLInputValue => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
};

export class SqlStorage {
  private savepoint = 0;
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  exec(query: string, ...params: unknown[]): Cursor {
    if (params.length === 0 && statements(query) > 1) {
      this.db.exec(query);
      return new Cursor([], 0);
    }
    const rows = this.db.prepare(query).all(...params.map(bindable)) as Row[];
    const { written } = this.db.prepare("SELECT changes() AS written").get() as { written: number };
    return new Cursor(rows, written);
  }

  inTransaction<T>(run: () => T): T {
    this.savepoint += 1;
    const name = `sp${this.savepoint}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = run();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.savepoint -= 1;
    }
  }
}

class Storage {
  readonly sql = new SqlStorage(new DatabaseSync(":memory:"));
  private readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  transactionSync<T>(run: () => T): T {
    return this.sql.inTransaction(run);
  }

  async transaction<T>(run: (transaction: Storage) => Promise<T>): Promise<T> {
    return run(this);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    for (const [name, held] of entries) this.values.set(name, structuredClone(held));
  }

  async delete(keys: string | string[]): Promise<boolean | number> {
    if (typeof keys === "string") return this.values.delete(keys);
    return keys.filter((key) => this.values.delete(key)).length;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
}

export class DurableObjectState {
  readonly storage = new Storage();
  readonly id: { name: string; toString(): string };
  private readonly pending: Promise<unknown>[] = [];

  constructor(name: string) {
    this.id = { name, toString: () => name };
  }

  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
    const running = run();
    this.pending.push(running);
    return running;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  abort(reason: string): never {
    throw new Error(`the Durable Object ${this.id.name} aborted: ${reason}`);
  }

  async settle(): Promise<void> {
    while (this.pending.length > 0) await this.pending.shift();
  }
}

type Alarmed = { alarm?: () => Promise<void> };
type DurableObjectClass<T> = new (ctx: never, env: never) => T;

export class Namespace<T extends object> {
  readonly instances = new Map<string, { object: T; ctx: DurableObjectState }>();
  private readonly runtime: Runtime;
  private readonly create: (ctx: DurableObjectState) => T;

  constructor(runtime: Runtime, create: (ctx: DurableObjectState) => T) {
    this.runtime = runtime;
    this.create = create;
  }

  getByName(name: string): T {
    return this.instance(name).object;
  }

  idFromName(name: string): string {
    return name;
  }

  get(id: string): T {
    return this.getByName(id);
  }

  instance(name: string): { object: T; ctx: DurableObjectState } {
    const held = this.instances.get(name);
    if (held !== undefined) return held;
    const ctx = new DurableObjectState(name);
    const created = { object: this.create(ctx), ctx };
    this.instances.set(name, created);
    this.runtime.track(created);
    return created;
  }
}

export class Runtime {
  private readonly objects: { object: Alarmed; ctx: DurableObjectState }[] = [];

  constructor(start: number) {
    mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: start });
  }

  namespace<T extends object>(Class: DurableObjectClass<T>, env: () => unknown): Namespace<T> {
    return new Namespace(this, (ctx) => new Class(ctx as never, env() as never));
  }

  stubs<T extends object>(create: (name: string) => T): Namespace<T> {
    return new Namespace(this, (ctx) => create(ctx.id.name));
  }

  track(held: { object: object; ctx: DurableObjectState }): void {
    this.objects.push(held);
  }

  now(): number {
    return Date.now();
  }

  async settle(): Promise<void> {
    for (const { ctx } of this.objects) await ctx.settle();
  }

  async advance(ms: number): Promise<void> {
    const until = Date.now() + ms;
    for (;;) {
      await this.settle();
      const due = this.objects
        .filter(({ ctx }) => ctx.storage.alarmAt !== null && (ctx.storage.alarmAt ?? Infinity) <= until)
        .sort((a, b) => (a.ctx.storage.alarmAt ?? 0) - (b.ctx.storage.alarmAt ?? 0))[0];
      if (due === undefined) break;
      const at = due.ctx.storage.alarmAt ?? until;
      if (at > Date.now()) mock.timers.setTime(at);
      due.ctx.storage.alarmAt = null;
      await due.object.alarm?.();
    }
    if (until > Date.now()) mock.timers.setTime(until);
    await this.settle();
  }

  close(): void {
    mock.timers.reset();
  }
}

export const migratedDatabase = (directory: URL): DatabaseSync => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  return db;
};

class D1Statement {
  private params: unknown[] = [];
  private readonly sql: SqlStorage;
  private readonly query: string;

  constructor(sql: SqlStorage, query: string) {
    this.sql = sql;
    this.query = query;
  }

  bind(...params: unknown[]): D1Statement {
    this.params = params;
    return this;
  }

  run(): Promise<{ results: Row[]; success: true; meta: { changes: number } }> {
    const cursor = this.sql.exec(this.query, ...this.params);
    return Promise.resolve({ results: cursor.toArray(), success: true, meta: { changes: cursor.rowsWritten } });
  }

  all(): Promise<{ results: Row[]; success: true; meta: { changes: number } }> {
    return this.run();
  }

  async first(column?: string): Promise<unknown> {
    const [row] = (await this.run()).results;
    if (row === undefined) return null;
    return column === undefined ? row : row[column];
  }

  async raw(): Promise<unknown[][]> {
    return (await this.run()).results.map((row) => Object.values(row));
  }
}

export class D1Database {
  readonly sql: SqlStorage;

  constructor(db: DatabaseSync) {
    this.sql = new SqlStorage(db);
  }

  prepare(query: string): D1Statement {
    return new D1Statement(this.sql, query);
  }

  batch(statements: D1Statement[]): Promise<unknown[]> {
    return this.sql.inTransaction(() => Promise.all(statements.map((statement) => statement.run())));
  }
}

class R2Object {
  readonly key: string;
  private readonly body: Uint8Array;

  constructor(key: string, body: Uint8Array) {
    this.key = key;
    this.body = body;
  }

  get size(): number {
    return this.body.byteLength;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.body);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.body.slice().buffer;
  }
}

export class R2Bucket {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<R2Object> {
    const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, body);
    return new R2Object(key, body);
  }

  async get(key: string): Promise<R2Object | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : new R2Object(key, body);
  }

  async head(key: string): Promise<R2Object | null> {
    return this.get(key);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{ objects: R2Object[]; truncated: false }> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => new R2Object(key, body));
    return { objects, truncated: false };
  }
}
