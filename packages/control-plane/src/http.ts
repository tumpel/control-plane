import { OAuthErrorSchema, type ProblemResponseSchema, ProblemSchema } from "@tumpel/schemas";
import type { z } from "zod";

export type Problem = z.infer<typeof ProblemSchema>;
export type ProblemStatus = z.infer<typeof ProblemResponseSchema>["statusCode"];
export type OAuthError = z.infer<typeof OAuthErrorSchema>;
export type OAuthErrorCode = OAuthError["error"];

const NO_STORE = { "cache-control": "no-store" };

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

export const readJson = async (request: Request): Promise<unknown> => request.json().catch(() => null);

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

export const parseBody = async <T>(request: Request, schema: z.ZodType<T>, operation: string): Promise<Parsed<T>> => {
  const parsed = schema.safeParse(await readJson(request));
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
