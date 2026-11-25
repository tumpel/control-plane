import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("D1 contract migrations require a reason", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "migration-check-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const directory = "packages/control-plane/migrations";
  const file = `${directory}/0029_contract.sql`;
  mkdirSync(join(cwd, directory), { recursive: true });
  mkdirSync(join(cwd, "npm-scripts"));
  copyFileSync(new URL("./migration-check.mjs", import.meta.url), join(cwd, "npm-scripts/migration-check.mjs"));
  writeFileSync(join(cwd, file), "");
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["add", file], { cwd });

  for (const sql of [
    "ALTER TABLE hosts DROP COLUMN reported_health;",
    "-- contract-reviewed: \nALTER TABLE hosts DROP COLUMN reported_health;",
    'ALTER TABLE "main"."hosts" RENAME COLUMN "name" TO "label";',
    "ALTER TABLE hosts RENAME TO workers;",
    "DROP TABLE IF EXISTS hosts;",
    "ALTER TABLE hosts ADD COLUMN health INTEGER NOT NULL REFERENCES health(id) ON DELETE SET DEFAULT;",
  ]) {
    writeFileSync(join(cwd, file), sql);
    const result = spawnSync(process.execPath, ["npm-scripts/migration-check.mjs"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 1, sql);
    assert.match(result.stderr, /breaks rollback\.[\s\S]*0029_contract\.sql[\s\S]*contract-reviewed/);
  }

  for (const sql of [
    "-- contract-reviewed: the previous release stopped using reported_health\nALTER TABLE hosts DROP COLUMN reported_health;",
    "ALTER TABLE hosts ADD COLUMN health INTEGER NOT NULL DEFAULT (1);",
    "ALTER TABLE hosts ADD COLUMN health INTEGER CHECK (health IS NOT NULL);",
  ]) {
    writeFileSync(join(cwd, file), sql);
    execFileSync(process.execPath, ["npm-scripts/migration-check.mjs"], { cwd });
  }
});
