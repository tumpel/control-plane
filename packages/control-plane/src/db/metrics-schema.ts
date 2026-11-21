import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const metric = sqliteTable("metric", {
  metric: text("metric").notNull().primaryKey(),
  unit: text("unit").notNull(),
  kind: text("kind").notNull(),
  description: text("description").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
