import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const host = sqliteTable("host", {
  hostId: text("host_id").primaryKey(),
  publicKey: text("public_key").notNull(),
  revoked: integer("revoked").notNull(),
});

export const ledger = sqliteTable("ledger", {
  ledgerId: integer("ledger_id").primaryKey(),
  received: integer("received").notNull(),
  sent: integer("sent").notNull(),
  unacked: text("unacked").notNull(),
});
