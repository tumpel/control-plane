import type {
  OpenRouterAuthorizationFailureReasonSchema,
  OpenRouterAuthorizationSchema,
  OpenRouterAuthorizationStateSchema,
} from "@tumpel/api/schemas";
import { z } from "zod";
import type { Fetch } from "./github.ts";

export type OpenRouterAuthorization = z.infer<typeof OpenRouterAuthorizationSchema>;
export type OpenRouterAuthorizationFailureReason = z.infer<typeof OpenRouterAuthorizationFailureReasonSchema>;
export type OpenRouterAuthorizationState = z.infer<typeof OpenRouterAuthorizationStateSchema>;

export const OPENROUTER_ORIGIN = "https://openrouter.ai";
export const OPENROUTER_MEMBER = "OPENROUTER_API_KEY";
export const OPENROUTER_PROVIDER = "OpenRouter";
export const CALLBACK_PATH = "/openrouter/callback/";
export const CALLBACK_BUDGET_SECONDS = 600;
export const STATE_PURPOSE = "tumpel-openrouter-state-v1";

const EXCHANGE_TIMEOUT_MS = 15_000;
const KEY_LABEL_LIMIT = 100;
export const CONNECT_AGAIN =
  "choose Connect OpenRouter again on the secret set's page in the dashboard, or run tumpel openrouter authorize";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const StateClaimsSchema = z.object({
  purpose: z.literal("OpenRouterAuthorization"),
  tenantId: z.string().min(1),
  openRouterAuthorizationId: z.string().min(1),
});

export type StateClaims = z.infer<typeof StateClaimsSchema>;

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const signState = async (key: CryptoKey, claims: StateClaims): Promise<string> => {
  const body = base64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64Url(new Uint8Array(signature))}`;
};

export type StateCheck = { ok: true; claims: StateClaims } | { ok: false; reason: string };

export const readState = async (key: CryptoKey, state: string): Promise<StateCheck> => {
  const refused = {
    ok: false,
    reason: "the callback address carries a state this control plane did not sign",
  } as const;
  const [body, signature, extra] = state.split(".");
  if (body === undefined || signature === undefined || extra !== undefined) return refused;
  const bodyBytes = fromBase64Url(body);
  const signatureBytes = fromBase64Url(signature);
  if (bodyBytes === null || signatureBytes === null) return refused;
  if (!(await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(body)))) return refused;
  const claims = StateClaimsSchema.safeParse(parseJson(decoder.decode(bodyBytes)));
  if (!claims.success) return { ok: false, reason: "the callback address carries a state signed for another flow" };
  return { ok: true, claims: claims.data };
};

export const callbackUrl = (controlPlaneOrigin: string, state: string): string =>
  new URL(`${CALLBACK_PATH}${state}`, controlPlaneOrigin).toString();

export const stateOfPath = (pathname: string): string | null => {
  if (!pathname.startsWith(CALLBACK_PATH)) return null;
  const state = pathname.slice(CALLBACK_PATH.length);
  return state === "" || state.includes("/") ? null : state;
};

export const authorizeUrl = (request: { callbackUrl: string; challenge: string; keyLabel: string }): string => {
  const url = new URL("/auth", OPENROUTER_ORIGIN);
  url.search = new URLSearchParams({
    callback_url: request.callbackUrl,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
    key_label: request.keyLabel,
  }).toString();
  return url.toString();
};

export const keyLabelOf = (secretSetName: string): string => `Tumpel ${secretSetName}`.slice(0, KEY_LABEL_LIMIT);

export type OpenRouterCallback =
  | { kind: "Code"; code: string }
  | { kind: "NoCode" }
  | { kind: "Invalid"; detail: string };

export const parseCallback = (search: URLSearchParams): OpenRouterCallback => {
  const codes = search.getAll("code");
  if (codes.length === 0) return { kind: "NoCode" };
  const [code] = codes;
  if (codes.length > 1 || code === undefined || code === "") {
    return {
      kind: "Invalid",
      detail: `the callback address carries ${codes.length > 1 ? "several codes" : "an empty code"}, not the one code OpenRouter sends`,
    };
  }
  return { kind: "Code", code };
};

export type OpenRouterAuthorizationEvent = { kind: "Callback"; now: number; dueAt: number } | { kind: "Deadline" };

export type OpenRouterAuthorizationStep =
  | { kind: "Proceed" }
  | { kind: "Fail"; reason: OpenRouterAuthorizationFailureReason; detail: string }
  | { kind: "Refuse"; detail: string }
  | { kind: "Ignore" };

const timedOut = (openRouterAuthorizationId: string): OpenRouterAuthorizationStep => ({
  kind: "Fail",
  reason: "AuthorizationTimedOut",
  detail: `no callback with a code reached OpenRouter authorization ${openRouterAuthorizationId} within ${CALLBACK_BUDGET_SECONDS / 60} minutes, the lifetime OpenRouter gives a code; ${CONNECT_AGAIN} and approve on OpenRouter within that time`,
});

export const advanceAuthorization = (
  openRouterAuthorizationId: string,
  state: OpenRouterAuthorizationState,
  event: OpenRouterAuthorizationEvent,
): OpenRouterAuthorizationStep => {
  if (state !== "AwaitingCallback") {
    if (event.kind === "Deadline") return { kind: "Ignore" };
    return {
      kind: "Refuse",
      detail: `OpenRouter authorization ${openRouterAuthorizationId} is ${state} and takes no callback`,
    };
  }
  if (event.kind === "Deadline" || event.now >= event.dueAt) return timedOut(openRouterAuthorizationId);
  return { kind: "Proceed" };
};

export const notConnectedDetail = (): string =>
  `OpenRouter sent the browser back without a code, as it does when the authorization is declined; ${CONNECT_AGAIN} and choose Authorize on OpenRouter's page`;

const failed = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const ErrorBodySchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional(), code: z.unknown().optional() })]).optional(),
  message: z.string().optional(),
});

const errorText = (text: string): string => {
  const body = ErrorBodySchema.safeParse(parseJson(text));
  if (!body.success) return "no error message";
  const { error, message } = body.data;
  const named = typeof error === "string" ? error : error?.message;
  return named ?? message ?? "no error message";
};

const KeySchema = z.object({ key: z.string().min(1) });

export type KeyExchange =
  | { kind: "Key"; key: string }
  | { kind: "Refused"; detail: string }
  | { kind: "Failed"; detail: string };

export const exchangeCode = async (fetcher: Fetch, grant: { code: string; verifier: string }): Promise<KeyExchange> => {
  const response = await fetcher(new URL("/api/v1/auth/keys", OPENROUTER_ORIGIN).toString(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "tumpel" },
    body: JSON.stringify({ code: grant.code, code_verifier: grant.verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  }).catch(failed);
  if (response instanceof Error) {
    return {
      kind: "Failed",
      detail: `OpenRouter did not answer POST /api/v1/auth/keys within ${EXCHANGE_TIMEOUT_MS / 1000} s: ${response.message}; ${CONNECT_AGAIN}`,
    };
  }
  const text = await response.text();
  if (response.status === 403) {
    return {
      kind: "Refused",
      detail: `OpenRouter answered POST /api/v1/auth/keys with 403: ${errorText(text)}; the code was spent, expired after 10 minutes or does not match this authorization's verifier, so ${CONNECT_AGAIN}`,
    };
  }
  if (!response.ok) {
    return {
      kind: "Failed",
      detail: `OpenRouter answered POST /api/v1/auth/keys with ${response.status}: ${errorText(text)}; ${CONNECT_AGAIN} once https://status.openrouter.ai is green`,
    };
  }
  const minted = KeySchema.safeParse(parseJson(text));
  if (!minted.success) {
    return {
      kind: "Failed",
      detail: `OpenRouter answered POST /api/v1/auth/keys with ${response.status} and no key; ${CONNECT_AGAIN}`,
    };
  }
  return { kind: "Key", key: minted.data.key };
};

export const returnTo = (returnUrl: string, openRouterAuthorizationId: string): string => {
  const url = new URL(returnUrl);
  url.searchParams.set("openRouterAuthorizationId", openRouterAuthorizationId);
  return url.toString();
};
