import assert from "node:assert/strict";
import { test } from "node:test";
import { contractChanges } from "./migration-check.mjs";

const hosts = "CREATE TABLE hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL, reported_health INTEGER);";

test("contract migrations require a reason", () => {
  for (const [before, migration, expected] of [
    [[hosts], "ALTER TABLE hosts DROP COLUMN reported_health;", ["drops column hosts.reported_health"]],
    [
      [hosts],
      "-- contract-reviewed: \nALTER TABLE hosts DROP COLUMN reported_health;",
      ["drops column hosts.reported_health"],
    ],
    [
      [hosts],
      'ALTER TABLE "main"."hosts" RENAME COLUMN "name" TO "label";',
      ["drops column hosts.name", "adds hosts.label NOT NULL without a default"],
    ],
    [[hosts], "ALTER TABLE hosts RENAME TO workers;", ["drops table hosts"]],
    [[hosts], "DROP TABLE IF EXISTS hosts;", ["drops table hosts"]],
    [
      [hosts, "CREATE TABLE health (id INTEGER PRIMARY KEY);"],
      "ALTER TABLE hosts ADD COLUMN health INTEGER NOT NULL REFERENCES health(id) ON DELETE SET DEFAULT;",
      ["adds hosts.health NOT NULL without a default"],
    ],
    [
      [hosts],
      "CREATE TABLE hosts_new (id TEXT PRIMARY KEY, name TEXT NOT NULL);\nINSERT INTO hosts_new SELECT id, name FROM hosts;\nDROP TABLE hosts;\nALTER TABLE hosts_new RENAME TO hosts;",
      ["drops column hosts.reported_health"],
    ],
    [
      [hosts],
      "-- contract-reviewed: the previous release stopped using reported_health\nALTER TABLE hosts DROP COLUMN reported_health;",
      [],
    ],
    [[hosts], "ALTER TABLE hosts ADD COLUMN health INTEGER NOT NULL DEFAULT (1);", []],
    [[hosts], "ALTER TABLE hosts ADD COLUMN health INTEGER CHECK (health IS NOT NULL);", []],
    [[hosts], "CREATE TABLE health (id INTEGER PRIMARY KEY, level INTEGER NOT NULL);", []],
  ]) {
    assert.deepEqual(contractChanges(before, migration), expected, migration);
  }
});
