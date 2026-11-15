import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  CIRCLECI_PARAMETER_LIMIT,
  circleCIParameters,
  overLongParameter,
  triggerPipeline,
  verifyCircleCISignature,
} from "../src/circleci.ts";

const SLUG = "circleci/6f1c2b3a-0d4e-4f5a-9b8c-7d6e5f4a3b2c/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DEFINITION = "11111111-2222-4333-8444-555555555555";

let api: Server;
let origin: string;
let answer: { status: number; body: unknown } = { status: 201, body: {} };
let received: { url: string; token: string; body: unknown } | null = null;

const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

before(async () => {
  api = createServer(async (request, response) => {
    received = {
      url: request.url ?? "",
      token: String(request.headers["circle-token"]),
      body: await bodyOf(request),
    };
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(() => api.close());

const parameters = circleCIParameters({
  prebuildId: "prebuild-1",
  tenantId: "tenant-1",
  apiOrigin: "https://api.tumpel.dev",
  rootfsUrl: "https://releases.example.test/rootfs?signed",
  imageDigest: "b".repeat(64),
});

const trigger = () =>
  triggerPipeline((url, init) => fetch(url, init), origin, "personal-token", {
    projectSlug: SLUG,
    definitionId: DEFINITION,
    branch: "main",
    parameters,
  });

test("the trigger runs the definition on the default branch with the five tumpel parameters, and a 201 names the pipeline", async () => {
  answer = { status: 201, body: { id: "pipeline-1", state: "created", number: 7, created_at: "2026-11-15T10:00:00Z" } };
  assert.deepEqual(await trigger(), { kind: "Created", pipelineId: "pipeline-1", number: 7 });
  assert.equal(received?.url, `/api/v2/project/${SLUG}/pipeline/run`);
  assert.equal(received?.token, "personal-token");
  assert.deepEqual(received?.body, {
    definition_id: DEFINITION,
    config: { branch: "main" },
    checkout: { branch: "main" },
    parameters: {
      tumpel_prebuild_id: "prebuild-1",
      tumpel_tenant_id: "tenant-1",
      tumpel_api_origin: "https://api.tumpel.dev",
      tumpel_rootfs_url: "https://releases.example.test/rootfs?signed",
      tumpel_image_digest: "b".repeat(64),
    },
  });
});

test("a 200 without a pipeline, a pipeline in state errored and a 401 each refuse the trigger with CircleCI's answer", async () => {
  const refusals: [{ status: number; body: unknown }, RegExp, number][] = [
    [{ status: 200, body: { message: "No workflows ran." } }, /created no pipeline: No workflows ran\./, 200],
    [{ status: 201, body: { id: "pipeline-2", state: "errored", number: 8 } }, /pipeline-2 in state errored/, 201],
    [{ status: 401, body: { message: "Invalid token provided." } }, /with 401: Invalid token provided\./, 401],
  ];
  for (const [reply, detail, status] of refusals) {
    answer = reply;
    const run = await trigger();
    assert.ok(run.kind === "Refused", JSON.stringify(run));
    assert.equal(run.status, status);
    assert.match(run.detail, detail);
  }
});

test("a pipeline parameter longer than 512 characters is named before any trigger", () => {
  assert.equal(overLongParameter(parameters), null);
  const atLimit = { ...parameters, tumpel_rootfs_url: "u".repeat(CIRCLECI_PARAMETER_LIMIT) };
  assert.equal(overLongParameter(atLimit), null);
  const over = { ...parameters, tumpel_rootfs_url: "u".repeat(CIRCLECI_PARAMETER_LIMIT + 1) };
  assert.deepEqual(overLongParameter(over), { name: "tumpel_rootfs_url", length: 513 });
});

test("the circleci-signature check takes any v1 HMAC-SHA256 of the body under the secret and refuses every other header", async () => {
  const body = new TextEncoder().encode('{"type":"workflow-completed"}');
  const v1 = (secret: string) => `v1=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const verify = (header: string | null) => verifyCircleCISignature("binding-secret", body.buffer, header);
  assert.equal(await verify(v1("binding-secret")), true);
  assert.equal(await verify(`v1=${"0".repeat(64)},${v1("binding-secret")}`), true);
  assert.equal(await verify(v1("another-secret")), false);
  assert.equal(await verify(v1("binding-secret").replace("v1=", "v2=")), false);
  assert.equal(await verify(null), false);
  assert.equal(await verify(""), false);
});
