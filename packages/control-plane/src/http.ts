import { OAuthErrorSchema, type ProblemResponseSchema, ProblemSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { MAX_BODY_BYTES } from "./limits.ts";

export { MAX_BODY_BYTES, MAX_CONFIG_BODY_BYTES } from "./limits.ts";

export type Problem = z.infer<typeof ProblemSchema>;
export type ProblemStatus = z.infer<typeof ProblemResponseSchema>["statusCode"];
export type OAuthError = z.infer<typeof OAuthErrorSchema>;
export type OAuthErrorCode = OAuthError["error"];

const NO_STORE = { "cache-control": "no-store" };

export const storedJson = (text: string): Response =>
  new Response(text, { headers: { ...NO_STORE, "content-type": "application/json" } });

export const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

export const problem = (status: ProblemStatus, body: Problem, headers: Record<string, string> = {}): Response =>
  json(ProblemSchema.parse(body), status, headers);

export const signedOut = (detail: string, fix: string): Response =>
  problem(401, { code: "SignedOut", title: "Not signed in", detail, fix }, { "www-authenticate": "Bearer" });

export const oauthError = (error: OAuthErrorCode, description: string, status: 400 | 405 | 429 = 400): Response =>
  json(OAuthErrorSchema.parse({ error, error_description: description }), status);

export const seeOther = (location: string): Response =>
  new Response(null, { status: 303, headers: { location, ...NO_STORE } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const bodyTooLarge = (detail: string): Response =>
  problem(413, {
    code: "BodyTooLarge",
    title: "Request body too large",
    detail,
    fix: "Send a smaller body, or split it into several requests",
  });

export type BoundedBody = { ok: true; value: unknown } | { ok: false; detail: string };

export const readBoundedJson = async (request: Request, maxBytes = MAX_BODY_BYTES): Promise<BoundedBody> => {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      detail: `the body is ${bytes.byteLength} bytes, over the ${maxBytes}-byte bound on this request body`,
    };
  }
  return { ok: true, value: await new Response(bytes).json().catch(() => null) };
};

export const readJson = async (request: Request): Promise<unknown> => {
  const body = await readBoundedJson(request);
  return body.ok ? body.value : null;
};

export const readParams = async (request: Request): Promise<Record<string, unknown>> => {
  if ((request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(await request.text()));
  }
  const body = await readJson(request);
  return isRecord(body) ? { ...body } : {};
};

export const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

export const parseBody = async <T>(
  request: Request,
  schema: z.ZodType<T>,
  operation: string,
  maxBytes = MAX_BODY_BYTES,
): Promise<Parsed<T>> => {
  const body = await readBoundedJson(request, maxBytes);
  if (!body.ok) {
    return {
      ok: false,
      response: bodyTooLarge(`${operation} refused the body: ${body.detail}`),
    };
  }
  const parsed = schema.safeParse(body.value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    response: problem(400, {
      code: "InvalidRequest",
      title: "Invalid request body",
      detail: `${operation} refused the body: ${issues(parsed.error)}`,
      fix: "Send a JSON body that matches the operation's schema in typespec",
    }),
  };
};

const joined = (chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
};

export const withinBodyBound = async (request: Request, bound: number): Promise<Request | Response> => {
  if (request.body === null) return request;
  const where = `${request.method} ${new URL(request.url).pathname}`;
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (bytes <= bound) return request;
    return bodyTooLarge(
      `the body declares ${bytes} bytes, over the ${bound}-byte bound on ${where}; nothing of it was read`,
    );
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > bound) {
      await reader.cancel();
      return bodyTooLarge(`the body runs past the ${bound}-byte bound on ${where}; reading stopped there`);
    }
    chunks.push(value);
  }
  return new Request(request, { body: joined(chunks, total) });
};
