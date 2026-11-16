import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SHELL_MARKER } from "@tumpel/pages";
import { ProblemSchema } from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { TEST_SETTINGS } from "./timing.ts";

const AUDIENCE = "tumpel-pages";
const KID = "pages-key";
const DASHBOARD = "https://dashboard.tumpel.test";
const EMAIL = "pages@example.test";
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const SHELL_MODULE = "pages.ts";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;

type HarnessResponse = Awaited<ReturnType<TestHarness["fetch"]>>;

const signedIn = (): Record<string, string> => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600 });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url");
  return { "cf-access-jwt-assertion": `${header}.${payload}.${signature}`, origin };
};

const BROWSER = { accept: "text/html,application/xhtml+xml" };

const browse = (path: string, headers: Record<string, string> = {}): Promise<HarnessResponse> =>
  server.fetch(`${origin}${path}`, { redirect: "manual", headers: { ...BROWSER, ...headers } });

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );

before(async () => {
  certs = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => certs.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(certs.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          TUMPEL_SETTINGS: TEST_SETTINGS,
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: AUDIENCE,
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
          DASHBOARD_ORIGIN: DASHBOARD,
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

after(async () => {
  await server?.close();
  certs?.close();
});

test("only the shell module builds a text/html response", () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => relative(SRC, file) !== SHELL_MODULE)
    .filter((file) => readFileSync(file, "utf8").includes("text/html"))
    .map((file) => relative(SRC, file));
  assert.deepEqual(
    offenders,
    [],
    `answer HTML through htmlPage in src/${SHELL_MODULE}, not in ${offenders.join(", ")}`,
  );
});

const BROWSER_ROUTES: [string, string, Record<string, string> | "signedIn", number][] = [
  ["device signed out", "/device", {}, 401],
  ["device without a tenant", "/device", "signedIn", 200],
  ["consent signed out", "/oauth/consent?request=unknown", {}, 401],
  ["consent without a tenant", "/oauth/consent?request=unknown", "signedIn", 403],
  ["authorize for an unknown client", "/oauth/authorize?client_id=unknown", {}, 400],
  ["invitation signed out", "/invitations/accept?token=unknown", {}, 401],
  ["github app setup signed out", "/github/app/setup", {}, 401],
  ["github app created signed out", "/github/app/created", {}, 401],
  ["github install callback signed out", "/github/app/installed", {}, 401],
  ["download without a release", "/v1/releases/cli/Amd64", {}, 404],
  ["download for an unknown architecture", "/v1/releases/supervisor/Sparc", {}, 400],
  ["unknown path", "/no/such/page", {}, 404],
];

test("every browser route answers through the shell", async () => {
  for (const [name, path, headers, status] of BROWSER_ROUTES) {
    const response = await browse(path, headers === "signedIn" ? signedIn() : headers);
    assert.equal(response.status, status, name);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/, name);
    assert.match(response.headers.get("content-security-policy") ?? "", new RegExp(`img-src ${DASHBOARD}`), name);
    assert.ok((await response.text()).includes(SHELL_MARKER), `${name} renders outside the shell`);
  }
});

test("a signed-in browser walks the device, consent and invitation pages through the shell", async () => {
  const signUp = await server.fetch(`${origin}/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signedIn() },
    body: JSON.stringify({ name: "Pages" }),
  });
  assert.equal(signUp.status, 200);
  for (const [path, status, title] of [
    ["/device", 200, "Sign in a device"],
    ["/device?code=ZZZZ-ZZZZ", 404, "Code not found"],
    ["/oauth/consent?request=unknown", 404, "Nothing to connect"],
    ["/invitations/accept?token=unknown", 404, "No such invitation"],
    ["/github/app/setup", 200, "Create the GitHub App"],
    ["/github/app/created", 400, "Nothing to create"],
    ["/github/app/installed", 400, "Nothing to connect"],
  ] as const) {
    const response = await browse(path, signedIn());
    assert.equal(response.status, status, path);
    const page = await response.text();
    assert.ok(page.includes(SHELL_MARKER), `${path} renders outside the shell`);
    assert.ok(page.includes(`<title>${title} · Tumpel</title>`), `${path} is not titled ${title}`);
    assert.ok(page.includes(EMAIL), `${path} does not name the signed-in email`);
  }
});

test("a client that does not ask for HTML keeps the JSON problem", async () => {
  for (const path of ["/no/such/page", "/v1/releases/cli/Amd64"]) {
    const response = await server.fetch(`${origin}${path}`, { headers: { accept: "application/json" } });
    assert.equal(response.status, 404, path);
    ProblemSchema.parse(await response.json());
  }
});
