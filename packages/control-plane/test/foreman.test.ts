import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ChannelProtocol,
  HostSchema,
  MintedEnrolmentTokenSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  PersonaSchema,
  SecretSetSchema,
  SessionSchema,
  StartedSessionSchema,
  SubscriptionSchema,
  TenantEventSchema,
  TurnSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";
import { ControlEnvelopeSchema, helloBytes } from "../src/channel/protocol.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";
import { GIVE_UP_MS, TEST_SETTINGS, until } from "./timing.ts";

const AUDIENCE = "tumpel-foreman-e2e";
const KID = "foreman-e2e-key";
const EMAIL = "foreman@example.test";
const CALLBACK = "https://client.example.test/callback";
const SETTINGS = { ...TEST_SETTINGS, snapshotDelaySeconds: 1, snapshotDeadlineSeconds: 60 };

type WorkerConfig = Extract<
  Extract<Parameters<typeof createTestHarness>[0], object>["workers"][number],
  { config: unknown }
>["config"];

const { env: _stages, ...config }: WorkerConfig & { env?: unknown } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8"),
);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

type ControlMessage = Extract<z.infer<typeof ControlEnvelopeSchema>, { type: "Frame" }>["message"];

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;

const assertion = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600 });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`;
};

const browser = (): Record<string, string> => ({ "cf-access-jwt-assertion": assertion(), origin });

const call = (path: string, init: NonNullable<Parameters<TestHarness["fetch"]>[1]> = {}) =>
  server.fetch(`${origin}${path}`, { redirect: "manual", ...init });

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const putObject = async (key: string, body: string): Promise<void> => {
  const response = await call(`/__fixture/objects/STORE/${key}`, { method: "PUT", body });
  assert.equal(response.status, 204, await response.text());
};

const storeRoot = async (storageKey: string): Promise<void> => {
  const manifest = JSON.stringify({
    entries: [
      { kind: "File", path: "f", mode: 420, uid: 0, gid: 0, mtimeSeconds: 0, mtimeNanos: 0, sizeBytes: 0, chunks: [] },
    ],
  });
  const digest = createHash("sha256").update(manifest).digest("hex");
  await putObject(`${storageKey.split("/")[0]}/packs/${digest}`, manifest);
  await putObject(
    storageKey,
    JSON.stringify({ manifest: [{ digest, packDigest: digest, offset: 0, length: manifest.length }] }),
  );
};

const personToken = async (tenantId: string): Promise<string> => {
  const registered = await postJson("/oauth/register", { redirect_uris: [CALLBACK], client_name: "foreman e2e" });
  const client = OAuthClientSchema.parse(await registered.json());
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    state: "foreman",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const consent = new URL((await call(`/oauth/authorize?${authorize}`)).headers.get("location") ?? "");
  const csrf = randomBytes(32).toString("base64url");
  const approved = await call(consent.pathname, {
    method: "POST",
    headers: {
      ...browser(),
      "content-type": "application/x-www-form-urlencoded",
      cookie: `__Host-tumpel_connect=${csrf}`,
    },
    body: new URLSearchParams({
      request: consent.searchParams.get("request") ?? "",
      csrf,
      tenant: tenantId,
      action: "approve",
    }).toString(),
  });
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
    }).toString(),
  });
  assert.equal(token.status, 200);
  return OAuthTokenSchema.parse(await token.json()).access_token;
};

let mcpId = 0;

const mcpCall = async (token: string, name: string, args: Record<string, unknown>) => {
  mcpId += 1;
  const response = await postJson(
    "/mcp",
    { jsonrpc: "2.0", id: mcpId, method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${token}` },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result.content[0]?.text ?? "", isError: body.result.isError === true };
};

const tool = async <T>(token: string, name: string, args: Record<string, unknown>, schema: z.ZodType<T>) => {
  const { text, isError } = await mcpCall(token, name, args);
  assert.equal(isError, false, `${name} failed: ${text}`);
  return schema.parse(JSON.parse(text));
};

const refusal = async (token: string, name: string, args: Record<string, unknown>): Promise<string> => {
  const { text, isError } = await mcpCall(token, name, args);
  assert.equal(isError, true, `${name} answered ${text}`);
  return text;
};

class Host {
  private received = 0;
  private sent = 0;
  private readonly inbox: ControlMessage[] = [];
  private readonly heartbeat: NodeJS.Timeout;
  private readonly socket: WebSocket;
  private welcomed = false;
  private readonly held = new Set<string>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const envelope = ControlEnvelopeSchema.parse(JSON.parse(String(event.data)));
      if (envelope.type === "Welcome") this.welcomed = true;
      if (envelope.type !== "Frame" || envelope.seq <= this.received) return;
      this.received = envelope.seq;
      if (envelope.message.type === "TurnOffer") this.held.add(envelope.message.sessionId);
      this.inbox.push(envelope.message);
    });
    this.heartbeat = setInterval(() => this.beat(), SETTINGS.heartbeatIntervalSeconds * 1000);
  }

  static async connect(hostId: string, key: Parameters<typeof sign>[2]): Promise<Host> {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/hosts/${hostId}/channel`);
    const challenge = await new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    );
    const parsed = ControlEnvelopeSchema.parse(JSON.parse(challenge));
    assert.equal(parsed.type, "Challenge");
    const host = new Host(socket);
    socket.send(
      JSON.stringify({
        type: "Hello",
        hostId,
        protocolVersion: ChannelProtocol.Version,
        supervisorVersion: "0.1.0",
        signature: sign(null, helloBytes(parsed.nonce, hostId), key).toString("base64"),
        boxCapacity: 8,
        usage: host.usage(),
      }),
    );
    return host;
  }

  private usage() {
    return { boxesWarm: 0, loadAverage: 0.25, memoryAvailableMib: 6144, diskBudgetMib: 200000, diskHeldMib: 0 };
  }

  private beat(): void {
    if (!this.welcomed) return;
    this.socket.send(
      JSON.stringify({
        type: "Heartbeat",
        sentAt: new Date().toISOString(),
        usage: this.usage(),
        heldSessionIds: [...this.held],
      }),
    );
  }

  send(message: Record<string, unknown>): void {
    this.sent += 1;
    this.socket.send(JSON.stringify({ type: "Frame", seq: this.sent, ack: this.received, message }));
  }

  async next<K extends ControlMessage["type"]>(type: K): Promise<Extract<ControlMessage, { type: K }>> {
    const deadline = Date.now() + GIVE_UP_MS;
    for (;;) {
      const at = this.inbox.findIndex((message) => message.type === type);
      if (at !== -1) return this.inbox.splice(at, 1)[0] as Extract<ControlMessage, { type: K }>;
      if (Date.now() > deadline) assert.fail(`no ${type} reached the host; held ${JSON.stringify(this.inbox)}`);
      await wait(20);
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.socket.close();
  }
}

let host: Host | undefined;

const turnToken = async (offer: Extract<ControlMessage, { type: "TurnOffer" }>): Promise<string> => {
  const tumpel = offer.credential.connectors.find((connector) => connector.connectorId === "tumpel");
  assert.ok(tumpel, `turn ${offer.turnId} carries no tumpel connector`);
  const response = await server.fetch(tumpel.tokenUrl.replace(/^https?:\/\/[^/]+/, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${tumpel.tokenCredential}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return z.object({ accessToken: z.string() }).parse(await response.json()).accessToken;
};

const run = (offer: Extract<ControlMessage, { type: "TurnOffer" }>): void => {
  host?.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
  host?.send({
    type: "TurnLine",
    turnId: offer.turnId,
    lineSeq: offer.lastLineSeq + 1,
    text: '{"type":"system","subtype":"init"}',
  });
};

const complete = async (person: string, offer: Extract<ControlMessage, { type: "TurnOffer" }>): Promise<void> => {
  const result = '{"type":"result","subtype":"success","is_error":false}';
  host?.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: offer.lastLineSeq + 2, text: result });
  host?.send({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: offer.lastLineSeq + 2,
    completedAt: new Date().toISOString(),
  });
  const snapshot = await host?.next("SnapshotRequest");
  assert.equal(snapshot?.turnId, offer.turnId);
  await storeRoot(snapshot.storageKey);
  host?.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });
  await until(
    `turn ${offer.turnId} reading Completed`,
    () => tool(person, "tumpel_turn_get", { turnId: offer.turnId }, TurnSchema),
    (turn) => turn.state === "Completed",
  );
};

before(async () => {
  certs = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/user" ? { id: 4242, login: "crew-worker" } : { keys: [jwk] }));
  });
  await new Promise<void>((resolve) => certs.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(certs.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        config: {
          ...config,
          main: "./test/fixtures/sessions-worker.ts",
          vars: {
            ...config.vars,
            ACCESS_ISSUER: issuer,
            ACCESS_AUD: AUDIENCE,
            TUMPEL_SETTINGS: SETTINGS,
            R2_STUB_ORIGIN: "https://r2.example.test",
            SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
            DASHBOARD_ORIGIN: "https://app.tumpel.test",
            GITHUB_API_ORIGIN: issuer,
          },
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const release = await call("/__fixture/objects/RELEASES/current.json", {
    method: "PUT",
    body: JSON.stringify(CLAUDE_CODE_AMD64_RELEASE),
  });
  assert.equal(release.status, 204);
});

after(async () => {
  host?.close();
  await server?.close();
  certs?.close();
});

test("a foreman subscribed to its crew gets each crew turn as a delivery turn until its goal is met", async () => {
  const signedUp = await postJson("/v1/tenants", { name: "Foreman" }, browser());
  const { tenantId } = WhoamiSchema.parse(await signedUp.json()).tenant;
  const person = await personToken(tenantId);
  const bearer = { authorization: `Bearer ${person}` };

  const secrets = [
    { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: "sk-ant-foreman-e2e" },
    { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-foreman-e2e" },
  ];
  const savedSet = await postJson("/v1/secret-sets", { name: "foreman", secrets }, bearer);
  assert.equal(savedSet.status, 200, await savedSet.clone().text());
  const secretSet = SecretSetSchema.parse(await savedSet.json());
  const persona = PersonaSchema.parse(
    await (
      await postJson(
        "/v1/personas",
        { name: "Crew", harness: "ClaudeCode", secretSetId: secretSet.secretSetId, connectorIds: [], tumpelMcp: true },
        bearer,
      )
    ).json(),
  );

  const { token: enrolmentToken } = MintedEnrolmentTokenSchema.parse(
    await (await postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer)).json(),
  );
  const hostKey = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(hostKey.publicKey.export({ format: "jwk" }).x ?? "", "base64url").toString("base64");
  const enrolled = await postJson("/v1/hosts/enrol", {
    name: "box",
    architecture: "Amd64",
    cpuCount: 2,
    memoryBytes: 8 * 1024 ** 3,
    publicKey,
    supervisorVersion: "0.1.0",
    enrolmentToken,
  });
  assert.equal(enrolled.status, 200, await enrolled.clone().text());
  const { hostId } = HostSchema.parse(await enrolled.json());
  host = await Host.connect(hostId, hostKey.privateKey);
  await until(
    "the host reading Online",
    async () => HostSchema.parse(await (await call(`/v1/hosts/${hostId}`, { headers: bearer })).json()),
    (read) => read.state === "Online",
  );

  const start = {
    repository: "https://github.com/acme/app.git",
    model: "claude-sonnet-5-5",
    personaId: persona.personaId,
  };
  const foreman = await tool(
    person,
    "tumpel_session_start",
    { ...start, prompt: "work through the open issues" },
    StartedSessionSchema,
  );
  const foremanId = foreman.session.sessionId;
  const created = await tool(
    person,
    "tumpel_subscription_create",
    {
      sessionId: foremanId,
      prompt: "start a crew session per open issue and review what it did",
      goal: "every open issue has a merged pull request",
      events: ["TurnCompleted"],
      crewTags: ["crew:issues"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    SubscriptionSchema,
  );
  assert.equal(created.state, "Active");

  const foremanTurn = await host.next("TurnOffer");
  assert.equal(foremanTurn.sessionId, foremanId);
  run(foremanTurn);
  const foremanToken = await turnToken(foremanTurn);
  const crew = await tool(
    foremanToken,
    "tumpel_session_start",
    { ...start, prompt: "fix issue 12", tags: ["issue-12"] },
    StartedSessionSchema,
  );
  assert.deepEqual(crew.session.tags, ["crew:issues", "issue-12"]);
  assert.deepEqual(crew.session.startedBy, {
    kind: "Turn",
    sessionId: foremanId,
    turnId: foremanTurn.turnId,
  });
  await complete(person, foremanTurn);

  const crewTurn = await host.next("TurnOffer");
  assert.equal(crewTurn.sessionId, crew.session.sessionId);
  run(crewTurn);
  const crewToken = await turnToken(crewTurn);
  const subscriptionArgs = {
    sessionId: crew.session.sessionId,
    prompt: "watch myself",
    goal: "done",
    events: ["TurnCompleted"],
    crewTags: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  assert.match(
    await refusal(crewToken, "tumpel_subscription_create", subscriptionArgs),
    /only a person creates or resumes a subscription/,
  );
  assert.match(
    await refusal(crewToken, "tumpel_subscription_resume", { subscriptionId: created.subscriptionId }),
    /only a person creates or resumes a subscription/,
  );
  await complete(person, crewTurn);

  const delivery = await host.next("TurnOffer");
  assert.equal(delivery.sessionId, foremanId);
  assert.ok(delivery.credential.connectors.some((connector) => connector.connectorId === "tumpel"));
  assert.match(delivery.prompt, /^\/goal start a crew session per open issue and review what it did\n\n/);
  assert.match(delivery.prompt, /Done when: every open issue has a merged pull request\./);
  const events = delivery.prompt
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => TenantEventSchema.parse(JSON.parse(line)));
  assert.deepEqual(
    events.map((event) => ({ event: event.event, sessionId: "sessionId" in event ? event.sessionId : null })),
    [{ event: "TurnCompleted", sessionId: crew.session.sessionId }],
  );
  run(delivery);
  await complete(person, delivery);
  const delivered = await tool(
    person,
    "tumpel_subscription_get",
    { subscriptionId: created.subscriptionId },
    SubscriptionSchema,
  );
  assert.equal(delivered.cursorEventId, events[0]?.eventId);

  const completed = await tool(
    person,
    "tumpel_subscription_complete",
    { subscriptionId: created.subscriptionId },
    SubscriptionSchema,
  );
  assert.equal(completed.state, "Ended");
  assert.equal(completed.state === "Ended" ? completed.reason : null, "GoalMet");
  const listed = await tool(person, "tumpel_session_list", { tag: ["crew:issues"] }, SessionSchema.array());
  assert.deepEqual(
    listed.map((session) => session.sessionId),
    [crew.session.sessionId],
  );
});
