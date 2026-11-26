import { createHash, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { mock } from "node:test";

type Row = Record<string, unknown>;

Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  value: (left: ArrayBufferView | ArrayBuffer, right: ArrayBufferView | ArrayBuffer): boolean =>
    timingSafeEqual(
      ArrayBuffer.isView(left) ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength) : new Uint8Array(left),
      ArrayBuffer.isView(right)
        ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
        : new Uint8Array(right),
    ),
  configurable: true,
});

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
  readonly changed: number;
  readonly rowsReadUnmeasured = 0;

  constructor(rows: Row[], rowsWritten: number, changed: number) {
    this.rows = rows;
    this.rowsWritten = rowsWritten;
    this.changed = changed;
  }

  get rowsRead(): number {
    return this.rowsReadUnmeasured;
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

const INDEX_ROOTS =
  "SELECT rootpage FROM sqlite_master WHERE type = 'index' AND rootpage NOT IN (SELECT rootpage FROM sqlite_master WHERE type = 'table')";

const INDEX_WRITES = new Set(["IdxInsert", "IdxDelete", "Delete"]);

export class SqlStorage {
  private savepoint = 0;
  readonly db: DatabaseSync;
  rowsWritten = 0;
  private readonly opened = new Map<string, number>();
  private readonly prepared = new Map<string, StatementSync>();
  private readonly totalChanges: StatementSync;
  private readonly schemaVersion: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.totalChanges = db.prepare("SELECT total_changes() AS written");
    this.schemaVersion = db.prepare("PRAGMA schema_version");
  }

  exec(query: string, ...params: unknown[]): Cursor {
    const before = this.changed();
    const several = params.length === 0 && statements(query) > 1;
    let rows: Row[] = [];
    if (several) this.db.exec(query);
    else rows = this.statement(query).all(...params.map(bindable)) as Row[];
    const changed = this.changed() - before;
    const written = changed === 0 || several ? changed : changed + this.indexWrites(query);
    this.rowsWritten += written;
    return new Cursor(rows, written, changed);
  }

  private statement(query: string): StatementSync {
    const known = this.prepared.get(query);
    if (known !== undefined) return known;
    const statement = this.db.prepare(query);
    this.prepared.set(query, statement);
    return statement;
  }

  private changed(): number {
    const { written } = this.totalChanges.get() as { written: number };
    return written;
  }

  private indexWrites(query: string): number {
    const { schema_version: version } = this.schemaVersion.get() as { schema_version: number };
    const key = `${version}\n${query}`;
    const known = this.opened.get(key);
    if (known !== undefined) return known;
    const indexes = new Set(
      this.db
        .prepare(INDEX_ROOTS)
        .all()
        .map(({ rootpage }) => Number(rootpage)),
    );
    const program = this.db.prepare(`EXPLAIN ${query}`).all();
    const roots = new Map(
      program
        .filter(({ opcode, p2 }) => opcode === "OpenWrite" && indexes.has(Number(p2)))
        .map(({ p1, p2 }) => [Number(p1), Number(p2)]),
    );
    const writes = new Set(
      program
        .filter(({ opcode, p1 }) => INDEX_WRITES.has(String(opcode)) && roots.has(Number(p1)))
        .map(({ p1 }) => roots.get(Number(p1))),
    ).size;
    this.opened.set(key, writes);
    return writes;
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

export class Storage {
  readonly sql = new SqlStorage(new DatabaseSync(":memory:"));
  private readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(at: number | Date): Promise<void> {
    this.alarmAt = typeof at === "number" ? at : at.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

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

export const flight = {
  held: new Set<object>(),
  faults: [] as unknown[],
  get pending(): number {
    return this.held.size;
  },
  hold(): () => void {
    const token = {};
    const held = this.held;
    held.add(token);
    return () => {
      held.delete(token);
    };
  },
  reset(): void {
    this.held = new Set();
    this.faults = [];
  },
};

class Direction {
  private readonly held: (() => void)[] = [];
  private dropped = false;

  sent(): void {
    if (this.dropped) return;
    this.held.push(flight.hold());
  }

  arrived(): void {
    this.held.shift()?.();
  }

  drop(): void {
    this.dropped = true;
    for (const release of this.held.splice(0)) release();
  }
}

export class Link {
  readonly toServer = new Direction();
  readonly toClient = new Direction();
}

export type Wire = {
  send(data: string | Buffer): void;
  close(code: number, reason: string): void;
  terminate(): void;
};

type SocketHandler = {
  webSocketMessage?(socket: ServerSocket, message: string | ArrayBuffer): unknown;
  webSocketClose?(socket: ServerSocket, code: number, reason: string, wasClean: boolean): unknown;
};

const fault = (error: unknown): void => {
  flight.faults.push(error);
  console.error(error);
};

export class ServerSocket {
  readyState = 1;
  readonly link = new Link();
  ctx: DurableObjectState | null = null;
  private attachment: unknown = null;
  private wire: Wire | null = null;
  private severed = false;
  private readonly queued: ((wire: Wire) => void)[] = [];

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    this.link.toClient.sent();
    const bytes = typeof data === "string" ? data : Buffer.from(data);
    this.through((wire) => wire.send(bytes));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.link.toClient.sent();
    this.through((wire) => wire.close(code, reason));
  }

  bind(wire: Wire): void {
    this.wire = wire;
    if (this.severed) {
      wire.terminate();
      return;
    }
    for (const act of this.queued.splice(0)) act(wire);
  }

  sever(): void {
    this.severed = true;
    this.readyState = 3;
    this.ctx = null;
    this.wire?.terminate();
  }

  async receive(message: string | ArrayBuffer): Promise<void> {
    try {
      const ctx = this.ctx;
      if (ctx === null || this.readyState === 3) return;
      await ctx.unblocked();
      await ctx.handler().webSocketMessage?.(this, message);
    } catch (error) {
      fault(error);
    } finally {
      this.link.toServer.arrived();
    }
  }

  async closed(code: number, reason: string, wasClean: boolean): Promise<void> {
    const release = flight.hold();
    try {
      const ctx = this.ctx;
      if (ctx === null || this.readyState === 3) return;
      this.readyState = 2;
      await ctx.unblocked();
      await ctx.handler().webSocketClose?.(this, code, reason, wasClean);
    } catch (error) {
      fault(error);
    } finally {
      this.readyState = 3;
      this.link.toServer.drop();
      release();
    }
  }

  private through(act: (wire: Wire) => void): void {
    if (this.severed) return;
    if (this.wire === null) this.queued.push(act);
    else act(this.wire);
  }
}

export class ClientEnd {
  readonly server: ServerSocket;

  constructor(server: ServerSocket) {
    this.server = server;
  }
}

class WebSocketPair {
  readonly 0: ClientEnd;
  readonly 1: ServerSocket;

  constructor() {
    const server = new ServerSocket();
    this[0] = new ClientEnd(server);
    this[1] = server;
  }
}

const NodeResponse = globalThis.Response;

class WorkerResponse extends NodeResponse {
  readonly webSocket: ClientEnd | null;

  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: ClientEnd | null }) {
    const upgraded = init?.status === 101;
    super(upgraded ? null : body, upgraded ? { ...init, status: 200 } : init);
    this.webSocket = init?.webSocket ?? null;
    if (upgraded) Object.defineProperty(this, "status", { value: 101 });
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(NodeResponse, value);
  }
}

Object.assign(globalThis, { WebSocketPair, Response: WorkerResponse });
Object.defineProperty(globalThis.WebSocket, "READY_STATE_OPEN", { value: 1, configurable: true, writable: true });

export class DurableObjectState {
  readonly storage: Storage;
  readonly id: { name: string; toString(): string };
  object: object | null = null;
  private readonly pending: Promise<unknown>[] = [];
  private readonly sockets: ServerSocket[] = [];
  private blocking: Promise<unknown> = Promise.resolve();

  constructor(name: string, storage: Storage = new Storage()) {
    this.id = { name, toString: () => name };
    this.storage = storage;
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

  acceptWebSocket(socket: ServerSocket): void {
    socket.ctx = this;
    this.sockets.push(socket);
  }

  getWebSockets(): ServerSocket[] {
    return this.sockets.filter((socket) => socket.readyState !== 3);
  }

  handler(): SocketHandler {
    if (this.object === null) throw new Error(`the Durable Object ${this.id.name} has no live object`);
    return this.object as SocketHandler;
  }

  sever(): void {
    for (const socket of this.sockets.splice(0)) socket.sever();
  }

  idle(): boolean {
    return this.pending.length === 0;
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
    const io = this.io;
    const live = (): { object: T; ctx: DurableObjectState } => this.instance(name);
    return new Proxy(live().object, {
      get(_target, property) {
        const { object, ctx } = live();
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== "function") return value;
        return async (...given: unknown[]) => {
          const args =
            property === "fetch" && !(given[0] instanceof Request)
              ? [new Request(String(given[0]), given[1] as RequestInit | undefined)]
              : given;
          await ctx.unblocked();
          if (!io) return value.apply(object, args);
          return awaitingIo(async () => value.apply(object, args));
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
    const held = this.instance(name);
    held.ctx.sever();
    this.born(name, new DurableObjectState(name, held.ctx.storage));
  }

  hibernate(name: string): void {
    this.born(name, this.instance(name).ctx);
  }

  instance(name: string): { object: T; ctx: DurableObjectState } {
    return this.instances.get(name) ?? this.born(name, new DurableObjectState(name));
  }

  private born(name: string, ctx: DurableObjectState): { object: T; ctx: DurableObjectState } {
    const created = { object: this.create(ctx), ctx };
    ctx.object = created.object;
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

  idle(): boolean {
    return this.objects.every(({ ctx }) => ctx.idle());
  }

  async settle(): Promise<void> {
    for (const { ctx } of this.objects) await ctx.settle();
  }

  async advance(ms: number): Promise<void> {
    await this.settle();
    mock.timers.tick(ms);
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
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

type D1Meta = { changes: number; rows_written: number };

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

  run(): Promise<{ results: Row[]; success: true; meta: D1Meta }> {
    return Promise.resolve(
      spendingOnIo(() => {
        const cursor = this.sql.exec(this.query, ...this.params);
        return {
          results: cursor.toArray(),
          success: true as const,
          meta: { changes: cursor.changed, rows_written: cursor.rowsWritten },
        };
      }),
    );
  }

  all(): Promise<{ results: Row[]; success: true; meta: D1Meta }> {
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

type Stored = { body: Uint8Array; uploaded: Date; etag: string };

class R2Object {
  readonly key: string;
  readonly uploaded: Date;
  readonly size: number;
  readonly etag: string;

  constructor(key: string, stored: Stored) {
    this.key = key;
    this.uploaded = stored.uploaded;
    this.size = stored.body.byteLength;
    this.etag = stored.etag;
  }
}

class R2ObjectBody extends R2Object {
  private readonly bytes: Uint8Array;

  constructor(key: string, stored: Stored, bytes: Uint8Array) {
    super(key, stored);
    this.bytes = bytes;
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
  private readonly objects = new Map<string, Stored>();
  gets = 0;
  latencyMs = 0;
  failure: { operation: "get" | "head" | "delete"; prefix: string; error: Error } | null = null;

  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<R2Object> {
    return awaitingIo(() => this.store(key, value));
  }

  private async store(key: string, value: string | ArrayBuffer | Uint8Array): Promise<R2Object> {
    const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const stored = { body, uploaded: new Date(Date.now()), etag: createHash("md5").update(body).digest("hex") };
    this.objects.set(key, stored);
    return new R2Object(key, stored);
  }

  get(
    key: string,
    options: { range?: { offset: number; length: number }; onlyIf: { etagDoesNotMatch?: string } },
  ): Promise<R2ObjectBody | R2Object | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBody | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number }; onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<R2ObjectBody | R2Object | null> {
    return awaitingIo(async () => {
      await this.travels();
      this.gets += 1;
      this.fails("get", key);
      const stored = this.objects.get(key);
      if (stored !== undefined && stored.etag === options?.onlyIf?.etagDoesNotMatch) return new R2Object(key, stored);
      return this.read(key, options?.range);
    });
  }

  head(key: string): Promise<R2ObjectBody | null> {
    return awaitingIo(async () => {
      this.fails("head", key);
      return this.read(key, undefined);
    });
  }

  private async travels(): Promise<void> {
    const arrives = performance.now() + this.latencyMs;
    while (performance.now() < arrives) await new Promise((resolve) => setImmediate(resolve));
  }

  private read(key: string, range: { offset: number; length: number } | undefined): R2ObjectBody | null {
    const object = this.objects.get(key);
    if (object === undefined) return null;
    if (range === undefined) return new R2ObjectBody(key, object, object.body);
    return new R2ObjectBody(key, object, object.body.subarray(range.offset, range.offset + range.length));
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
  }): Promise<
    { objects: R2ObjectBody[]; truncated: true; cursor: string } | { objects: R2ObjectBody[]; truncated: false }
  > {
    return awaitingIo(async () => this.listed(options));
  }

  private listed(options?: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    limit?: number;
  }): { objects: R2ObjectBody[]; truncated: true; cursor: string } | { objects: R2ObjectBody[]; truncated: false } {
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
