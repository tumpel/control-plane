import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mock } from "node:test";

type Row = Record<string, unknown>;

export const ioClock = { spentMs: 0, depth: 0 };

const spendingOnIo = <T>(work: () => T): T => {
  const started = performance.now();
  ioClock.depth += 1;
  try {
    return work();
  } finally {
    ioClock.depth -= 1;
    if (ioClock.depth === 0) ioClock.spentMs += performance.now() - started;
  }
};

const awaitingIo = async <T>(work: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  ioClock.depth += 1;
  try {
    return await work();
  } finally {
    ioClock.depth -= 1;
    if (ioClock.depth === 0) ioClock.spentMs += performance.now() - started;
  }
};

class Cursor {
  private readonly rows: Row[];
  readonly rowsWritten: number;
  readonly rowsRead: number;

  constructor(rows: Row[], rowsWritten: number) {
    this.rows = rows;
    this.rowsWritten = rowsWritten;
    this.rowsRead = rows.length;
  }

  toArray(): Row[] {
    return this.rows;
  }

  one(): Row {
    const [row] = this.rows;
    if (row === undefined || this.rows.length > 1) throw new Error(`expected one row, got ${this.rows.length}`);
    return row;
  }

  raw(): { toArray(): unknown[][] } {
    const values = this.rows.map((row) => Object.values(row));
    return { toArray: () => values };
  }

  next(): IteratorResult<Row> {
    const [value] = this.rows;
    return value === undefined ? { done: true, value: undefined } : { done: false, value };
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
  rowsWritten = 0;

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
    const counted = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query) ? written : 0;
    this.rowsWritten += counted;
    return new Cursor(rows, counted);
  }

  totalRowsWritten(): number {
    const { written } = this.db.prepare("SELECT total_changes() AS written").get() as { written: number };
    return written;
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

  transactionSync<T>(run: () => T): T {
    return this.sql.inTransaction(run);
  }

  sync(): Promise<void> {
    return Promise.resolve();
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
}

export class DurableObjectState {
  readonly storage = new Storage();
  readonly id: { name: string; toString(): string };
  private readonly pending: Promise<unknown>[] = [];
  private blocking: Promise<unknown> = Promise.resolve();

  constructor(name: string) {
    this.id = { name, toString: () => name };
  }

  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
    const running = this.blocking.then(run);
    this.pending.push(running);
    this.blocking = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  async unblocked(): Promise<void> {
    let blocking: Promise<unknown> | undefined;
    while (blocking !== this.blocking) {
      blocking = this.blocking;
      await blocking;
    }
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

type DurableObjectClass<T> = new (ctx: never, env: never) => T;

export class Namespace<T extends object> {
  readonly instances = new Map<string, { object: T; ctx: DurableObjectState }>();
  private readonly runtime: Runtime;
  private readonly create: (ctx: DurableObjectState) => T;
  private readonly io: boolean;

  constructor(runtime: Runtime, create: (ctx: DurableObjectState) => T, io = false) {
    this.runtime = runtime;
    this.create = create;
    this.io = io;
  }

  getByName(name: string): T {
    const { object, ctx } = this.instance(name);
    const io = this.io;
    return new Proxy(object, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await ctx.unblocked();
          if (!io) return value.apply(target, args);
          return awaitingIo(async () => value.apply(target, args));
        };
      },
    });
  }

  idFromName(name: string): string {
    return name;
  }

  get(id: string): T {
    return this.getByName(id);
  }

  restart(name: string): void {
    const { ctx } = this.instance(name);
    const restarted = { object: this.create(ctx), ctx };
    this.instances.set(name, restarted);
    this.runtime.track(restarted);
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
  private readonly objects: { object: object; ctx: DurableObjectState }[] = [];

  constructor(start: number) {
    mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: start });
  }

  namespace<T extends object>(Class: DurableObjectClass<T>, env: () => unknown, io = false): Namespace<T> {
    return new Namespace(this, (ctx) => new Class(ctx as never, env() as never), io);
  }

  stubs<T extends object>(create: (name: string) => T): Namespace<T> {
    return new Namespace(this, (ctx) => create(ctx.id.name), true);
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
    await this.settle();
    mock.timers.setTime(Date.now() + ms);
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
    return Promise.resolve(
      spendingOnIo(() => {
        const cursor = this.sql.exec(this.query, ...this.params);
        return { results: cursor.toArray(), success: true as const, meta: { changes: cursor.rowsWritten } };
      }),
    );
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
    return awaitingIo(() => this.sql.inTransaction(() => Promise.all(statements.map((statement) => statement.run()))));
  }
}

export class RateLimiter {
  private readonly perMinute: number;
  private readonly windows = new Map<string, { start: number; used: number }>();

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const start = Date.now() - (Date.now() % 60_000);
    const held = this.windows.get(key);
    const window = held?.start === start ? held : { start, used: 0 };
    window.used += 1;
    this.windows.set(key, window);
    return Promise.resolve({ success: window.used <= this.perMinute });
  }
}

class R2Object {
  readonly key: string;
  readonly uploaded: Date;
  private readonly bytes: Uint8Array;

  constructor(key: string, bytes: Uint8Array, uploaded: Date) {
    this.key = key;
    this.bytes = bytes;
    this.uploaded = uploaded;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  get body(): ReadableStream<Uint8Array> {
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (at >= this.bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(this.bytes.slice(at, at + 65536));
        at += 65536;
      },
    });
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.bytes);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }
}

export class R2Bucket {
  private readonly objects = new Map<string, { body: Uint8Array; uploaded: Date }>();
  gets = 0;
  failure: { operation: "get" | "head" | "delete"; prefix: string; error: Error } | null = null;

  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<R2Object> {
    return awaitingIo(() => this.store(key, value));
  }

  private async store(key: string, value: string | ArrayBuffer | Uint8Array): Promise<R2Object> {
    const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const uploaded = new Date(Date.now());
    this.objects.set(key, { body, uploaded });
    return new R2Object(key, body, uploaded);
  }

  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2Object | null> {
    return awaitingIo(async () => {
      this.gets += 1;
      this.fails("get", key);
      return this.read(key, options?.range);
    });
  }

  head(key: string): Promise<R2Object | null> {
    return awaitingIo(async () => {
      this.fails("head", key);
      return this.read(key, undefined);
    });
  }

  private read(key: string, range: { offset: number; length: number } | undefined): R2Object | null {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    if (range === undefined) return new R2Object(key, object.body, object.uploaded);
    return new R2Object(key, object.body.subarray(range.offset, range.offset + range.length), object.uploaded);
  }

  private fails(operation: "get" | "head" | "delete", key: string): void {
    if (this.failure?.operation === operation && key.startsWith(this.failure.prefix)) throw this.failure.error;
  }

  delete(keys: string | string[]): Promise<void> {
    return awaitingIo(async () => {
      for (const key of Array.isArray(keys) ? keys : [keys]) this.fails("delete", key);
      for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
    });
  }

  list(options?: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    limit?: number;
  }): Promise<{ objects: R2Object[]; truncated: true; cursor: string } | { objects: R2Object[]; truncated: false }> {
    return awaitingIo(async () => this.listed(options));
  }

  private listed(options?: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    limit?: number;
  }): { objects: R2Object[]; truncated: true; cursor: string } | { objects: R2Object[]; truncated: false } {
    const prefix = options?.prefix ?? "";
    const after = options?.cursor ?? options?.startAfter ?? "";
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix) && key > after).sort();
    const page = keys.slice(0, options?.limit ?? 1000);
    const objects = page.flatMap((key) => this.read(key, undefined) ?? []);
    const last = page.at(-1);
    if (page.length < keys.length && last !== undefined) return { objects, truncated: true, cursor: last };
    return { objects, truncated: false };
  }
}
