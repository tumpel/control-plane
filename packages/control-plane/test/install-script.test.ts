import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const CLI = "#!/bin/sh\necho tumpel 0.0.0-test\n";
const CLI_SHA = createHash("sha256").update(CLI).digest("hex");
const SCRIPT = readFileSync(new URL("../src/install.sh", import.meta.url), "utf8");

let published = CLI_SHA;
let server: Server;
let origin: string;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/v1/releases/cli/Amd64" || request.url === "/v1/releases/cli/Arm64") {
      response.writeHead(302, { location: "/presigned/cli" });
      response.end();
      return;
    }
    if (request.url === "/presigned/cli") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(CLI);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

const rendered = (): string =>
  SCRIPT.replaceAll("@TUMPEL_ORIGIN@", origin).replaceAll(
    "@TUMPEL_CLI_SHA256S@",
    `Amd64 ${published}\nArm64 ${published}`,
  );

type Run = { status: number | null; stdout: string; stderr: string };

const install = (dir: string): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", rendered()], {
      env: { ...process.env, TUMPEL_INSTALL_DIR: dir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const scratch = (): string => mkdtempSync(join(tmpdir(), "tumpel-install-"));

test("the install script installs the CLI the release publishes and prints the login command", async () => {
  published = CLI_SHA;
  const dir = scratch();
  const run = await install(join(dir, "bin"));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`tumpel login --endpoint ${origin}\\n$`));
  assert.match(run.stdout, /to your PATH/);
  const installed = spawnSync(join(dir, "bin", "tumpel"), [], { encoding: "utf8" });
  assert.equal(installed.stdout, "tumpel 0.0.0-test\n");
  assert.deepEqual(readdirSync(join(dir, "bin")), ["tumpel"]);
  rmSync(dir, { recursive: true });
});

test("the install script refuses a CLI whose sha256 differs from the release and installs nothing", async () => {
  published = "0".repeat(64);
  const dir = scratch();
  const run = await install(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not match the checksum the release publishes/);
  assert.equal(existsSync(join(dir, "tumpel")), false);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true });
});
