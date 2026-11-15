import {
  InvitationAcceptSchema,
  InvitationCreatedSchema,
  InvitationCreateSchema,
  InvitationPathSchema,
  InvitationSchema,
  MemberPathSchema,
  MemberSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { base64Url, sameSecret } from "./crypto";
import type { PersonCheck } from "./github-handlers.ts";
import { json, parseBody, problem } from "./http";
import { type Caller, listTenants, type Role, type Whoami, whoamiOf } from "./identity";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { acceptPage, messagePage } from "./pages";

type Member = z.infer<typeof MemberSchema>;
type Invitation = z.infer<typeof InvitationSchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;
type SignedInPerson = (request: Request, env: Env) => Promise<PersonCheck>;
type SameOrigin = (request: Request, url: URL) => Response | null;

export const INVITATION_TTL_MS = 604_800_000;
export const ACCEPT_PAGE_PATH = "/invitations/accept";
const INVITATION_KEY_PURPOSE = "invitation";
const MEMBERS_PATH = "/v1/members";
const INVITATIONS_PATH = "/v1/invitations";
const ACCEPT_PATH = "/v1/invitations/accept";
const MEMBER_PATH = /^\/v1\/members\/([^/]+)$/;
const INVITATION_PATH = /^\/v1\/invitations\/([^/]+)$/;

const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export const ownerRequired = (caller: Caller, operation: string): Response | null =>
  caller.role === "Owner"
    ? null
    : problem(403, {
        code: "OwnerRequired",
        title: "Owner only",
        detail: `${operation} is for an Owner of the tenant, and you are a ${caller.role} of it`,
        fix: "Ask an Owner of the tenant to do it",
      });

export const listMembers = async (db: D1Database, tenantId: string): Promise<Member[]> => {
  const rows = await db
    .prepare(
      `SELECT m.tenant_id, m.principal_id, p.email, m.role, m.created_at FROM memberships m
      JOIN principals p ON p.principal_id = m.principal_id WHERE m.tenant_id = ? ORDER BY m.created_at, m.principal_id`,
    )
    .bind(tenantId)
    .all<{ tenant_id: string; principal_id: string; email: string; role: Role; created_at: number }>();
  return rows.results.map((row) =>
    MemberSchema.parse({
      principalId: row.principal_id,
      tenantId: row.tenant_id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
    }),
  );
};

export type Removal = "Removed" | "NotFound" | "LastOwner";

export const removeMember = async (db: D1Database, tenantId: string, principalId: string): Promise<Removal> => {
  const gone = "NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = ? AND principal_id = ?)";
  const signOut = (table: string) =>
    db
      .prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND principal_id = ? AND ${gone}`)
      .bind(tenantId, principalId, tenantId, principalId);
  const [removed] = await db.batch([
    db
      .prepare(
        `DELETE FROM memberships WHERE tenant_id = ? AND principal_id = ?
          AND (role <> 'Owner' OR (SELECT count(*) FROM memberships WHERE tenant_id = ? AND role = 'Owner') > 1)
        RETURNING principal_id`,
      )
      .bind(tenantId, principalId, tenantId),
    signOut("devices"),
    signOut("device_approvals"),
    signOut("oauth_tokens"),
    signOut("oauth_codes"),
  ]);
  if (removed?.results.length === 1) return "Removed";
  const kept = await db
    .prepare("SELECT role FROM memberships WHERE tenant_id = ? AND principal_id = ?")
    .bind(tenantId, principalId)
    .first<{ role: Role }>();
  return kept === null ? "NotFound" : "LastOwner";
};

const invitationKey = (env: Env): Promise<CryptoKey> => keyStoreOf(env).signingKey(INVITATION_KEY_PURPOSE);

const signatureOf = async (key: CryptoKey, invitationId: string): Promise<string> =>
  base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(invitationId))));

export const invitationToken = async (key: CryptoKey, invitationId: string): Promise<string> =>
  `${invitationId}.${await signatureOf(key, invitationId)}`;

const signedInvitationId = async (key: CryptoKey, token: string): Promise<string | null> => {
  const [invitationId, signature, ...extra] = token.split(".");
  if (invitationId === undefined || signature === undefined || extra.length > 0) return null;
  return sameSecret(signature, await signatureOf(key, invitationId)) ? invitationId : null;
};

interface InvitationRow {
  invitation_id: string;
  tenant_id: string;
  principal_id: string;
  email: string;
  role: Role;
  created_at: number;
  expires_at: number;
}

const INVITATION_COLUMNS = "invitation_id, tenant_id, principal_id, email, role, created_at, expires_at";

const toInvitation = (row: InvitationRow): Invitation =>
  InvitationSchema.parse({
    invitationId: row.invitation_id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    email: row.email,
    role: row.role,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: row.created_at,
  });

export const listInvitations = async (db: D1Database, tenantId: string, now: number): Promise<Invitation[]> => {
  const rows = await db
    .prepare(
      `SELECT ${INVITATION_COLUMNS} FROM invitations WHERE tenant_id = ? AND expires_at > ? ORDER BY created_at, invitation_id`,
    )
    .bind(tenantId, now)
    .all<InvitationRow>();
  return rows.results.map(toInvitation);
};

export type Invited = { ok: true; invitation: Invitation; invitationId: string } | { ok: false; member: string };

export const createInvitation = async (
  db: D1Database,
  caller: Caller,
  email: string,
  role: Role,
  now: number,
): Promise<Invited> => {
  const invited = email.toLowerCase();
  const invitationId = crypto.randomUUID();
  const [, inserted] = await db.batch<InvitationRow>([
    db.prepare("DELETE FROM invitations WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        `INSERT INTO invitations (${INVITATION_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM memberships m JOIN principals p ON p.principal_id = m.principal_id
          WHERE m.tenant_id = ? AND p.email = ?)
        RETURNING ${INVITATION_COLUMNS}`,
      )
      .bind(
        invitationId,
        caller.tenantId,
        caller.principalId,
        invited,
        role,
        now,
        now + INVITATION_TTL_MS,
        caller.tenantId,
        invited,
      ),
  ]);
  const row = inserted?.results[0];
  if (row === undefined) return { ok: false, member: invited };
  return { ok: true, invitation: toInvitation(row), invitationId };
};

export const revokeInvitation = async (db: D1Database, tenantId: string, invitationId: string): Promise<boolean> => {
  const revoked = await db
    .prepare("DELETE FROM invitations WHERE tenant_id = ? AND invitation_id = ? RETURNING invitation_id")
    .bind(tenantId, invitationId)
    .all();
  return revoked.results.length === 1;
};

export type Acceptance =
  | { kind: "Accepted"; whoami: Whoami }
  | { kind: "Unknown" }
  | { kind: "Expired" }
  | { kind: "OtherEmail"; email: string };

export type Preview = { kind: "Open"; tenantName: string; role: Role } | Exclude<Acceptance, { kind: "Accepted" }>;

const judge = (row: { email: string; expires_at: number } | null, email: string, now: number) => {
  if (row === null) return { kind: "Unknown" } as const;
  if (row.expires_at <= now) return { kind: "Expired" } as const;
  if (row.email !== email) return { kind: "OtherEmail", email: row.email } as const;
  return null;
};

export const previewInvitation = async (
  db: D1Database,
  key: CryptoKey,
  token: string,
  email: string,
  now: number,
): Promise<Preview> => {
  const invitationId = await signedInvitationId(key, token);
  if (invitationId === null) return { kind: "Unknown" };
  const row = await db
    .prepare(
      `SELECT i.email, i.expires_at, i.role, t.name FROM invitations i JOIN tenants t ON t.tenant_id = i.tenant_id
      WHERE i.invitation_id = ?`,
    )
    .bind(invitationId)
    .first<{ email: string; expires_at: number; role: Role; name: string }>();
  if (row === null) return { kind: "Unknown" };
  return judge(row, email, now) ?? { kind: "Open", tenantName: row.name, role: row.role };
};

export const acceptInvitation = async (
  db: D1Database,
  key: CryptoKey,
  token: string,
  email: string,
  now: number,
): Promise<Acceptance> => {
  const invitationId = await signedInvitationId(key, token);
  if (invitationId === null) return { kind: "Unknown" };
  const open = "i.invitation_id = ? AND i.email = ? AND i.expires_at > ?";
  const [, , spent] = await db.batch<{ tenant_id: string }>([
    db
      .prepare(
        `INSERT INTO principals (principal_id, email, created_at, updated_at)
        SELECT ?, i.email, ?, ? FROM invitations i WHERE ${open} ON CONFLICT (email) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), now, now, invitationId, email, now),
    db
      .prepare(
        `INSERT INTO memberships (tenant_id, principal_id, role, created_at)
        SELECT i.tenant_id, p.principal_id, i.role, ? FROM invitations i JOIN principals p ON p.email = i.email
        WHERE ${open} ON CONFLICT DO NOTHING`,
      )
      .bind(now, invitationId, email, now),
    db
      .prepare("DELETE FROM invitations WHERE invitation_id = ? AND email = ? AND expires_at > ? RETURNING tenant_id")
      .bind(invitationId, email, now),
  ]);
  const tenantId = spent?.results[0]?.tenant_id;
  if (tenantId !== undefined) {
    const principal = await db
      .prepare(
        "SELECT p.principal_id, m.role FROM principals p JOIN memberships m ON m.principal_id = p.principal_id WHERE p.email = ? AND m.tenant_id = ?",
      )
      .bind(email, tenantId)
      .first<{ principal_id: string; role: Role }>();
    if (principal === null) throw new Error(`accepting invitation ${invitationId} left ${email} no membership`);
    return {
      kind: "Accepted",
      whoami: await whoamiOf(db, { tenantId, principalId: principal.principal_id, role: principal.role }),
    };
  }
  const row = await db
    .prepare("SELECT email, expires_at FROM invitations WHERE invitation_id = ?")
    .bind(invitationId)
    .first<{ email: string; expires_at: number }>();
  const refused = judge(row, email, now);
  if (refused === null) throw new Error(`invitation ${invitationId} is open and was not spent`);
  return refused;
};

const acceptRefusal = (refused: Exclude<Acceptance, { kind: "Accepted" }>): Response => {
  if (refused.kind === "Expired") {
    return problem(410, {
      code: "InvitationExpired",
      title: "Invitation expired",
      detail: "this invitation passed its expiry before it was accepted",
      fix: "Ask an Owner of the tenant for a new invitation",
    });
  }
  if (refused.kind === "OtherEmail") {
    return problem(403, {
      code: "Forbidden",
      title: "Invitation for another email",
      detail: `this invitation is for ${refused.email}, and you are signed in as someone else`,
      fix: `Sign in to Cloudflare Access as ${refused.email}, or ask an Owner to invite the email you sign in with`,
    });
  }
  return problem(404, {
    code: "NotFound",
    title: "No such invitation",
    detail: "this invitation is unknown, revoked or already accepted",
    fix: "Ask an Owner of the tenant for a new invitation",
  });
};

const memberNotFound = (principalId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such member",
    detail: `principal ${principalId} is no member of your tenant`,
    fix: "List the members with tumpel member list and remove one of the principalIds it prints",
  });

const handleRemove = async (env: Env, caller: Caller, raw: string): Promise<Response> => {
  const refused = ownerRequired(caller, "members.remove");
  if (refused) return refused;
  const path = MemberPathSchema.safeParse({ principalId: raw });
  if (!path.success) return memberNotFound(raw);
  const removal = await removeMember(env.DB, caller.tenantId, path.data.principalId);
  if (removal === "Removed") return noContent();
  if (removal === "NotFound") return memberNotFound(raw);
  return problem(409, {
    code: "LastOwner",
    title: "Last Owner",
    detail: `principal ${raw} is the last Owner of the tenant`,
    fix: "Invite another Owner and let them accept first, then remove this one",
  });
};

const handleCreate = async (request: Request, url: URL, env: Env, caller: Caller): Promise<Response> => {
  const refused = ownerRequired(caller, "invitations.create");
  if (refused) return refused;
  const body = await parseBody(request, InvitationCreateSchema, "invitations.create");
  if (!body.ok) return body.response;
  const created = await createInvitation(env.DB, caller, body.value.email, body.value.role, Date.now());
  if (!created.ok) {
    return problem(409, {
      code: "Conflict",
      title: "Already a member",
      detail: `${created.member} is already a member of your tenant`,
      fix: "List the members with tumpel member list; invite an email that is not one of them",
    });
  }
  const token = await invitationToken(await invitationKey(env), created.invitationId);
  return json(
    InvitationCreatedSchema.parse({
      invitation: created.invitation,
      acceptUrl: `${url.origin}${ACCEPT_PAGE_PATH}?token=${encodeURIComponent(token)}`,
    }),
  );
};

const handleRevoke = async (env: Env, caller: Caller, raw: string): Promise<Response> => {
  const refused = ownerRequired(caller, "invitations.revoke");
  if (refused) return refused;
  const path = InvitationPathSchema.safeParse({ invitationId: raw });
  if (path.success && (await revokeInvitation(env.DB, caller.tenantId, path.data.invitationId))) return noContent();
  return problem(404, {
    code: "NotFound",
    title: "No such invitation",
    detail: `your tenant has no open invitation ${raw}`,
    fix: "List the open invitations with tumpel invitation list and revoke one of the ids it prints",
  });
};

const handleAccept = async (
  request: Request,
  url: URL,
  env: Env,
  signedIn: SignedInPerson,
  sameOrigin: SameOrigin,
  signedOutAnswer: (reason: string) => Response,
): Promise<Response> => {
  const person = await signedIn(request, env);
  if (!person.ok) return signedOutAnswer(person.reason);
  const crossOrigin = sameOrigin(request, url);
  if (crossOrigin) return crossOrigin;
  const body = await parseBody(request, InvitationAcceptSchema, "invitations.accept");
  if (!body.ok) return body.response;
  const accepted = await acceptInvitation(env.DB, await invitationKey(env), body.value.token, person.email, Date.now());
  return accepted.kind === "Accepted" ? json(WhoamiSchema.parse(accepted.whoami)) : acceptRefusal(accepted);
};

const handleAcceptPage = async (url: URL, env: Env, person: PersonCheck): Promise<Response> => {
  if (!person.ok) return messagePage(401, "Sign in again", `${person.reason}.`);
  const token = url.searchParams.get("token") ?? "";
  const preview = await previewInvitation(env.DB, await invitationKey(env), token, person.email, Date.now());
  if (preview.kind === "Open") {
    const next = env.DASHBOARD_ORIGIN ? env.DASHBOARD_ORIGIN : `${url.origin}/device`;
    return acceptPage(person.email, preview.tenantName, preview.role, token, next);
  }
  if (preview.kind === "Expired") {
    return messagePage(410, "Invitation expired", "This invitation expired. Ask an Owner of the tenant for a new one.");
  }
  if (preview.kind === "OtherEmail") {
    return messagePage(
      403,
      "Invitation for another email",
      `This invitation is for ${preview.email}, and you are signed in as ${person.email}. Sign in to Cloudflare Access as ${preview.email}.`,
    );
  }
  return messagePage(
    404,
    "No such invitation",
    "This invitation is unknown, revoked or already accepted. Ask an Owner of the tenant for a new one.",
  );
};

export interface MemberRouting {
  authenticate: Authenticate;
  signedIn: SignedInPerson;
  sameOrigin: SameOrigin;
  signedOut: (url: URL, reason: string) => Response;
}

export const handleMembers = async (
  request: Request,
  url: URL,
  env: Env,
  routing: MemberRouting,
): Promise<Response | null> => {
  const { pathname } = url;
  const method = request.method;
  if (method === "GET" && pathname === ACCEPT_PAGE_PATH) {
    return handleAcceptPage(url, env, await routing.signedIn(request, env));
  }
  if (method === "POST" && pathname === ACCEPT_PATH) {
    return handleAccept(request, url, env, routing.signedIn, routing.sameOrigin, (reason) =>
      routing.signedOut(url, reason),
    );
  }
  const memberId = MEMBER_PATH.exec(pathname)?.[1];
  const invitationId = INVITATION_PATH.exec(pathname)?.[1];
  const known =
    (pathname === "/v1/whoami/tenants" && method === "GET") ||
    (pathname === MEMBERS_PATH && method === "GET") ||
    (pathname === INVITATIONS_PATH && (method === "GET" || method === "POST")) ||
    (memberId !== undefined && method === "DELETE") ||
    (invitationId !== undefined && method === "DELETE");
  if (!known) return null;
  const caller = await routing.authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (pathname === "/v1/whoami/tenants") return json(await listTenants(env.DB, caller));
  if (pathname === MEMBERS_PATH) return json(await listMembers(env.DB, caller.tenantId));
  if (memberId !== undefined) return handleRemove(env, caller, decodeURIComponent(memberId));
  if (invitationId !== undefined) return handleRevoke(env, caller, decodeURIComponent(invitationId));
  if (method === "POST") return handleCreate(request, url, env, caller);
  return json(await listInvitations(env.DB, caller.tenantId, Date.now()));
};
