import type { Rows } from "./usage-meter.ts";

const meteredStorage = (storage: DurableObjectStorage, cursors: Rows[]): DurableObjectStorage =>
  new Proxy(storage, {
    get: (target, property) => {
      if (property !== "sql") {
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return new Proxy(target.sql, {
        get: (inner, name) => {
          const member: unknown = Reflect.get(inner, name);
          if (name !== "exec") return typeof member === "function" ? member.bind(inner) : member;
          return (query: string, ...bindings: unknown[]) => {
            const cursor = inner.exec(query, ...bindings);
            cursors.push(cursor);
            return cursor;
          };
        },
      });
    },
  });

export const meteredState = <Props>(ctx: DurableObjectState<Props>, cursors: Rows[]): DurableObjectState<Props> =>
  new Proxy(ctx, {
    get: (target, property) => {
      if (property === "storage") return meteredStorage(target.storage, cursors);
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
