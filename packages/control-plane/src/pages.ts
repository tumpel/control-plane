import { linksFor, type Page, type PageContext, type ServerLinks, shellDocument } from "@tumpel/pages";
import shell from "@tumpel/pages/shell.css";
import tokens from "@tumpel/pages/tokens.css";
import { APP_SETUP_PATH, GITHUB_WEB } from "./github.ts";

export const CONSENT_CSRF_COOKIE = "__Host-tumpel_connect";
export const DEVICE_PAGE = "/device";
export const SIGN_UP_PATH = "/v1/tenants";
export const DEVICE_APPROVE_PATH = "/v1/device/approve";
export const DEVICE_DENY_PATH = "/v1/device/deny";
export const INVITATION_ACCEPT_PATH = "/v1/invitations/accept";
const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export interface PageEnv {
  DASHBOARD_ORIGIN: string;
}

export const dashboardOrigin = (env: PageEnv): string => {
  if (!env.DASHBOARD_ORIGIN) {
    throw new Error(
      "DASHBOARD_ORIGIN is not set; deploy with npm run deploy, which sets it to https:// plus the tofu output dashboard_hostname, or pass --var DASHBOARD_ORIGIN:https://<dashboard hostname> to wrangler",
    );
  }
  return env.DASHBOARD_ORIGIN;
};

const linksOf = (env: PageEnv, url: URL): ServerLinks => ({
  ...linksFor({ dashboard: dashboardOrigin(env), api: url.origin }),
  routes: {
    signOut: `${url.origin}${ACCESS_LOGOUT_PATH}`,
    device: `${url.origin}${DEVICE_PAGE}`,
    appSetup: `${url.origin}${APP_SETUP_PATH}`,
    createTenant: `${url.origin}${SIGN_UP_PATH}`,
    approveDevice: `${url.origin}${DEVICE_APPROVE_PATH}`,
    denyDevice: `${url.origin}${DEVICE_DENY_PATH}`,
    acceptInvitation: `${url.origin}${INVITATION_ACCEPT_PATH}`,
  },
});

const contentSecurityPolicy = (links: ServerLinks, formActions: readonly string[]): string =>
  [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "connect-src 'self'",
    `img-src ${links.dashboard}`,
    `font-src ${links.dashboard}`,
    ["form-action 'self'", ...formActions].join(" "),
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

export type BuildPage = (links: ServerLinks, context: PageContext) => Page;

export const htmlPage = (
  env: PageEnv,
  url: URL,
  status: number,
  build: BuildPage,
  formActions: readonly string[] = [GITHUB_WEB],
): Response => {
  const links = linksOf(env, url);
  const context = { links, path: `${url.pathname}${url.search}`, at: new Date() };
  return new Response(shellDocument(build(links, context), context, { tokens, shell }), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy(links, formActions),
    },
  });
};

export const wantsHtml = (request: Request): boolean =>
  request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");

export const readCookie = (header: string | null, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};
