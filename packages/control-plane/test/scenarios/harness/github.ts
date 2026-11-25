import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateDataKey, seal } from "../../../src/envelope.ts";
import { workersSecretKeyStore } from "../../../src/key-store.ts";
import type { D1Database } from "./runtime.ts";

export const GITHUB_USER = { id: 4242, login: "ticket-worker" };
export const GITHUB_TOKEN_PREFIX = "ghp-e2e-";
export const INSTALLATION_ID = 77;
export const PREBUILT_HEAD = "5".repeat(40);
const PREBUILT_TREE = "6".repeat(40);
const PREBUILT_DEVCONTAINER_TREE = "9".repeat(40);
const PREBUILT_DEVCONTAINER = "8".repeat(40);
const BARE_TREE = "a".repeat(40);

const ISSUES: Record<string, { state: string; title: string; body: string }> = {
  "/repos/acme/app/issues/12": { state: "open", title: "Fix the login: it loops", body: "Steps: sign in" },
  "/repos/acme/app/issues/2": { state: "closed", title: "Done already", body: "" },
};

const repository = (method: string, path: string, now: number): { status: number; body: unknown } | null => {
  if (method === "GET" && path === `/app/installations/${INSTALLATION_ID}`) {
    return { status: 200, body: { permissions: { contents: "write", metadata: "read" } } };
  }
  if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
    return {
      status: 201,
      body: {
        token: "installation-token",
        expires_at: new Date(now + 3_600_000).toISOString(),
        permissions: { contents: "read" },
      },
    };
  }
  if (path === "/repos/prebuilt/app") return { status: 200, body: { default_branch: "main" } };
  if (path === "/repos/prebuilt/app/commits/main") {
    return { status: 200, body: { sha: PREBUILT_HEAD, commit: { tree: { sha: PREBUILT_TREE } } } };
  }
  if (path === `/repos/prebuilt/app/git/trees/${PREBUILT_TREE}`) {
    return {
      status: 200,
      body: {
        tree: [
          { path: ".devcontainer", type: "tree", sha: PREBUILT_DEVCONTAINER_TREE },
          { path: "package-lock.json", type: "blob", sha: "7".repeat(40) },
        ],
      },
    };
  }
  if (path === `/repos/prebuilt/app/git/trees/${PREBUILT_DEVCONTAINER_TREE}?recursive=1`) {
    return { status: 200, body: { tree: [{ path: "devcontainer.json", type: "blob", sha: PREBUILT_DEVCONTAINER }] } };
  }
  if (path === `/repos/prebuilt/app/git/blobs/${PREBUILT_DEVCONTAINER}`) {
    const content = Buffer.from('{ "onCreateCommand": "npm ci" }\n').toString("base64");
    return { status: 200, body: { content, encoding: "base64" } };
  }
  if (path === "/repos/prebuilt/bare") return { status: 200, body: { default_branch: "main" } };
  if (path === "/repos/prebuilt/bare/commits/main") {
    return { status: 200, body: { sha: PREBUILT_HEAD, commit: { tree: { sha: BARE_TREE } } } };
  }
  if (path === `/repos/prebuilt/bare/git/trees/${BARE_TREE}`) {
    return { status: 200, body: { tree: [{ path: "package-lock.json", type: "blob", sha: "7".repeat(40) }] } };
  }
  return null;
};

const answer = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const bodyOf = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
};

export class GitHubStub {
  readonly tokenRequests: unknown[] = [];
  beforeInstallationToken?: () => Promise<void>;
  private readonly userReads = new Map<string, number>();
  private readonly server: Server;
  origin = "";

  private constructor(server: Server) {
    this.server = server;
  }

  static async listen(): Promise<GitHubStub> {
    const stub = new GitHubStub(createServer());
    stub.server.on("request", (request, response) => {
      stub.handle(request, response).catch((error: unknown) => answer(response, 500, { message: String(error) }));
    });
    await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
    stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
    return stub;
  }

  reads(token: string): number {
    return this.userReads.get(token) ?? 0;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").toLowerCase();
    const body = await bodyOf(request);
    const known = repository(request.method ?? "", path, Date.now());
    if (known !== null) {
      if (body !== "") this.tokenRequests.push(JSON.parse(body));
      if (path === `/app/installations/${INSTALLATION_ID}/access_tokens`) await this.beforeInstallationToken?.();
      return answer(response, known.status, known.body);
    }
    const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const recognised = token.startsWith(GITHUB_TOKEN_PREFIX);
    if (path === "/user" && recognised) {
      this.userReads.set(token, this.reads(token) + 1);
      return answer(response, 200, GITHUB_USER);
    }
    const issue = ISSUES[path];
    if (issue === undefined || !recognised) return answer(response, 404, { message: "Not Found" });
    return answer(response, 200, {
      ...issue,
      number: Number(path.split("/").at(-1)),
      html_url: `https://github.com${path.replace("/repos", "")}`,
      updated_at: "2026-11-15T09:00:00Z",
      labels: [],
    });
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export const storeApp = async (db: D1Database, owner: string): Promise<void> => {
  const keyStore = workersSecretKeyStore(Buffer.alloc(32, 7).toString("base64"));
  const dataKey = await generateDataKey();
  const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const privateKey = appKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const now = Date.now();
  db.sql.exec(
    `INSERT OR IGNORE INTO github_apps (github_app_slot, app_id, slug, client_id, owner_login, html_url, wrapped_data_key,
    client_secret_sealed, webhook_secret_sealed, private_key_sealed, bot_user_id, created_at)
    VALUES (1, 1, 'tumpel-sessions', 'Iv1.sessions', ?, 'https://github.com/apps/tumpel-sessions', ?, ?, ?, ?, 4343, ?)`,
    owner,
    await keyStore.wrap(dataKey),
    await seal(dataKey, "sessions-client-secret", "github-app/client_secret"),
    await seal(dataKey, "sessions-webhook-secret", "github-app/webhook_secret"),
    await seal(dataKey, privateKey, "github-app/private_key"),
    now,
  );
};

export const installApp = async (db: D1Database, tenantId: string, owner: string): Promise<void> => {
  await storeApp(db, owner);
  const now = Date.now();
  db.sql.exec(
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Organization', 'Active', ?, ?)
    ON CONFLICT (installation_id) DO UPDATE SET tenant_id = excluded.tenant_id, account_login = excluded.account_login`,
    INSTALLATION_ID,
    tenantId,
    owner,
    now,
    now,
  );
};
