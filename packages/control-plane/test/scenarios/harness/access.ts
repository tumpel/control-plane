import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ACCESS_AUDIENCE = "tumpel-scenario";
const KID = "scenario-key";

export class AccessStub {
  private readonly rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly server: Server;
  issuer = "";

  private constructor() {
    const jwk = { ...this.rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
    this.server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
  }

  static async listen(): Promise<AccessStub> {
    const stub = new AccessStub();
    await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
    stub.issuer = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
    return stub;
  }

  assertion(email: string, audience = ACCESS_AUDIENCE): string {
    return this.signed({ aud: [audience], email });
  }

  serviceToken(commonName: string): string {
    return this.signed({ type: "app", aud: [ACCESS_AUDIENCE], common_name: commonName, sub: "" });
  }

  private signed(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
    const payload = encode({ iss: this.issuer, ...claims, iat: now, nbf: now, exp: now + 600 });
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), this.rsa.privateKey);
    return `${header}.${payload}.${signature.toString("base64url")}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
