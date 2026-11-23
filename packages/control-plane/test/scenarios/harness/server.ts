import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { ClientEnd, flight, type Link, type Runtime } from "./runtime.ts";

const LINK_HEADER = "x-scenario-link";
const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", LINK_HEADER]);
const BODILESS = new Set([101, 204, 205, 304]);
const SETTLE_GIVE_UP_MS = 10_000;

type Handle = (request: Request) => Promise<Response>;

const readBody = async (message: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const headersOf = (message: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, values] of Object.entries(message.headersDistinct)) {
    if (HOP_HEADERS.has(name) || values === undefined) continue;
    for (const value of values) headers.append(name, value);
  }
  return headers;
};

const linkFor = new Map<string, (link: Link) => void>();
const opened = new Map<WebSocket, Promise<void>>();

export class ScenarioServer {
  readonly origin: string;
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (_offered, request) => chosen.get(request) ?? false,
  });

  private constructor(server: Server) {
    this.server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  static async listen(handle: Handle): Promise<ScenarioServer> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const listening = new ScenarioServer(server);
    server.on("request", (message, response) => {
      const release = flight.hold();
      listening
        .answer(handle, message)
        .then(
          async (answered) => {
            const headers: Record<string, string | string[]> = {};
            answered.headers.forEach((value, name) => {
              if (name !== "set-cookie") headers[name] = value;
            });
            const cookies = answered.headers.getSetCookie();
            if (cookies.length > 0) headers["set-cookie"] = cookies;
            const body = Buffer.from(await answered.arrayBuffer());
            response.writeHead(answered.status, headers);
            response.end(body);
          },
          (error: unknown) => {
            flight.faults.push(error);
            console.error(error);
            response.writeHead(500, { "content-type": "text/plain" });
            response.end(String(error));
          },
        )
        .finally(release);
    });
    server.on("upgrade", (message: IncomingMessage, socket: Socket, head: Buffer) => {
      const release = flight.hold();
      listening
        .upgrade(handle, message, socket, head)
        .catch((error: unknown) => {
          flight.faults.push(error);
          console.error(error);
          socket.destroy();
        })
        .finally(release);
    });
    return listening;
  }

  private async answer(handle: Handle, message: IncomingMessage): Promise<Response> {
    const method = message.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(message);
    return handle(
      new Request(`${this.origin}${message.url ?? "/"}`, {
        method,
        headers: headersOf(message),
        body: body === undefined ? undefined : new Uint8Array(body),
      }),
    );
  }

  private async upgrade(handle: Handle, message: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const answered = await handle(new Request(`${this.origin}${message.url ?? "/"}`, { headers: headersOf(message) }));
    const end = (answered as Response & { webSocket?: unknown }).webSocket;
    if (answered.status !== 101 || !(end instanceof ClientEnd)) {
      const body = Buffer.from(await answered.arrayBuffer());
      const lines = [`HTTP/1.1 ${answered.status} ${STATUS_CODES[answered.status] ?? ""}`];
      answered.headers.forEach((value, name) => {
        lines.push(`${name}: ${value}`);
      });
      lines.push(`content-length: ${body.byteLength}`, "connection: close", "", "");
      socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
      return;
    }
    const server = end.server;
    const protocol = answered.headers.get("sec-websocket-protocol");
    if (protocol !== null) chosen.set(message, protocol);
    const linkId = message.headers[LINK_HEADER];
    if (typeof linkId === "string") linkFor.get(linkId)?.(server.link);
    await new Promise<void>((resolve) => {
      this.sockets.handleUpgrade(message, socket, head, (ws) => {
        ws.on("message", (data, isBinary) => {
          const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
          void server.receive(isBinary ? new Uint8Array(bytes).buffer : bytes.toString());
        });
        ws.on("close", (code, reason) => {
          void server.closed(code, reason.toString(), code !== 1006);
        });
        server.bind({
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          terminate: () => ws.terminate(),
        });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.all(opened.values());
  }
}

const chosen = new WeakMap<IncomingMessage, string>();

export type RequestInit = {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | Uint8Array | URLSearchParams | null;
  redirect?: string;
};

export const request = (url: string, init: RequestInit = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, name) => {
    headers[name] = value;
  });
  const body =
    init.body === undefined || init.body === null
      ? undefined
      : init.body instanceof URLSearchParams
        ? Buffer.from(init.body.toString())
        : Buffer.from(init.body);
  if (init.body instanceof URLSearchParams && headers["content-type"] === undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }
  if (body !== undefined) headers["content-length"] = String(body.byteLength);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method: init.method ?? "GET", headers }, (incoming) => {
      readBody(incoming).then((bytes) => {
        const status = incoming.statusCode ?? 500;
        const answered = new Headers();
        for (const [name, values] of Object.entries(incoming.headersDistinct)) {
          for (const value of values ?? []) answered.append(name, value);
        }
        resolve(new Response(BODILESS.has(status) ? null : new Uint8Array(bytes), { status, headers: answered }));
      }, reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
};

export const openSocket = (
  url: string,
  options: { protocols?: string[]; headers?: Record<string, string> } = {},
): WebSocket => {
  const id = randomUUID();
  let link: Link | null = null;
  linkFor.set(id, (given) => {
    link = given;
  });
  const release = flight.hold();
  let connecting = true;
  const connected = (): void => {
    if (!connecting) return;
    connecting = false;
    release();
    linkFor.delete(id);
  };
  const socket = new WebSocket(url, options.protocols ?? [], { headers: { ...options.headers, [LINK_HEADER]: id } });
  socket.on("open", connected);
  socket.on("error", connected);
  socket.on("unexpected-response", (_request, response) => {
    connected();
    socket.emit("error", new Error(`the server answered the upgrade with ${response.statusCode}`));
  });
  socket.on("message", () => link?.toClient.arrived());
  opened.set(
    socket,
    new Promise<void>((resolve) => {
      socket.on("close", () => {
        connected();
        link?.toClient.drop();
        opened.delete(socket);
        resolve();
      });
    }),
  );
  const send = socket.send.bind(socket);
  socket.send = ((data: string) => {
    link?.toServer.sent();
    send(data);
  }) as typeof socket.send;
  const close = socket.close.bind(socket);
  socket.close = ((code?: number, reason?: string) => {
    if (socket.readyState === WebSocket.OPEN) link?.toServer.sent();
    close(code, reason);
  }) as typeof socket.close;
  return socket;
};

export const settle = async (runtime: Runtime): Promise<void> => {
  const started = performance.now();
  for (let quiet = 0; quiet < 3; ) {
    await runtime.settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    quiet = flight.pending === 0 && runtime.idle() ? quiet + 1 : 0;
    if (performance.now() - started > SETTLE_GIVE_UP_MS) {
      throw new Error(`the scenario never went quiet: ${flight.pending} messages or requests still in flight`);
    }
  }
};
