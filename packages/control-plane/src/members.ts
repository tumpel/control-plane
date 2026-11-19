import {
  acceptPage,
  invitationExpiredPage,
  invitationNotFoundPage,
  invitationOtherEmailPage,
  signInAgainPage,
} from "@tumpel/pages";
import {
  InvitationAcceptSchema,
  InvitationCreatedSchema,
  InvitationCreateSchema,
  InvitationPathSchema,
  InvitationSchema,
  MemberPathSchema,
  PrincipalSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { randomToken, sha256Hex, TOKEN_PATTERN } from "./crypto";
import type { PersonCheck } from "./github-handlers.ts";
import { json, noContent, parseBody, problem } from "./http";
import { type Caller, type Role, type Whoami, whoamiOf } from "./identity";
import type { Env } from "./index";
import { htmlPage, INVITATION_ACCEPT_PATH } from "./pages";

type Principal = z.infer<typeof PrincipalSchema>;
type Invitation = z.infer<typeof InvitationSchema>;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;
type SignedInPerson = (request: Request, env: Env) => Promise<PersonCheck>;
type SameOrigin = (request: Request, url: URL) => Response | null;

export const INVITATION_TTL_MS = 604_800_000;
export const ACCEPT_PAGE_PATH = "/invitations/accept";
const MEMBERS_PATH = "/v1/members";
const INVITATIONS_PATH = "/v1/invitations";
const MEMBER_PATH = /^\/v1\/members\/([^/]+)$/;
const INVITATION_PATH = /^\/v1\/invitations\/([^/]+)$/;

export const ownerRequired = (caller: Caller, operation: string): Response | null =>
  caller.role === "Owner"
    ? null
    : problem(403, {
        code: "OwnerRequired",
        title: "Owner only",
        detail: `${operation} is for an Owner of the tenant, and you are a ${caller.role} of it`,
        fix: "Ask an Owner of the tenant to do it",
      });

export const listMembers = async (db: D1Database, tenantId: string): Promise<Principal[]> => {
  const rows = await db
    .prepare(
      `SELECT m.tenant_id, m.principal_id, p.email, m.role, p.created_at, p.updated_at FROM memberships m
      JOIN principals p ON p.principal_id = m.principal_id WHERE m.tenant_id = ? ORDER BY m.created_at, m.principal_id`,
    )
    .bind(tenantId)
    .all<{
      tenant_id: string;
      principal_id: string;
      email: string;
      role: Role;
      created_at: number;
      updated_at: number;
    }>();
  return rows.results.map((row) =>
    PrincipalSchema.parse({
      principalId: row.principal_id,
      tenantId: row.tenant_id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
};

export type Removal = "Removed" | "NotFound" | "LastOwner";

export const removeMember = async (db: D1Database, tenantId: string, principalId: string): Promise<Removal> => {
  const removed = await db
    .prepare(
      `DELETE FROM memberships WHERE tenant_id = ? AND principal_id = ?
        AND (role <> 'Owner' OR (SELECT count(*) FROM memberships WHERE tenant_id = ? AND role = 'Owner') > 1)
      RETURNING principal_id`,
    )
    .bind(tenantId, principalId, tenantId)
    .all();
  if (removed.results.length === 1) return "Removed";
  const kept = await db
    .prepare("SELECT role FROM memberships WHERE tenant_id = ? AND principal_id = ?")
    .bind(tenantId, principalId)
    .first<{ role: Role }>();
  return kept === null ? "NotFound" : "LastOwner";
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

export type Invited = { ok: true; invitation: Invitation; token: string } | { ok: false; member: string };

export const createInvitation = async (
  db: D1Database,
  caller: Caller,
  email: string,
  role: Role,
  now: number,
): Promise<Invited> => {
  const invited = email.toLowerCase();
  const token = randomToken();
  const row = await db
    .prepare(
      `INSERT INTO invitations (token_sha256, ${INVITATION_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM memberships m JOIN principals p ON p.principal_id = m.principal_id
        WHERE m.tenant_id = ? AND p.email = ?)
      RETURNING ${INVITATION_COLUMNS}`,
    )
    .bind(
      await sha256Hex(token),
      crypto.randomUUID(),
      caller.tenantId,
      caller.principalId,
      invited,
      role,
      now,
      now + INVITATION_TTL_MS,
      caller.tenantId,
      invited,
    )
    .first<InvitationRow>();
  if (row === null) return { ok: false, member: invited };
  return { ok: true, invitation: toInvitation(row), token };
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

const tokenHashOf = async (token: string): Promise<string | null> =>
  TOKEN_PATTERN.test(token) ? sha256Hex(token) : null;

export const previewInvitation = async (
  db: D1Database,
  token: string,
  email: string,
  now: number,
): Promise<Preview> => {
  const tokenHash = await tokenHashOf(token);
  if (tokenHash === null) return { kind: "Unknown" };
  const row = await db
    .prepare(
      `SELECT i.email, i.expires_at, i.role, t.name FROM invitations i JOIN tenants t ON t.tenant_id = i.tenant_id
      WHERE i.token_sha256 = ?`,
    )
    .bind(tokenHash)
    .first<{ email: string; expires_at: number; role: Role; name: string }>();
  if (row === null) return { kind: "Unknown" };
  return judge(row, email, now) ?? { kind: "Open", tenantName: row.name, role: row.role };
};

export const acceptInvitation = async (
  db: D1Database,
  token: string,
  email: string,
  now: number,
): Promise<Acceptance> => {
  const tokenHash = await tokenHashOf(token);
  if (tokenHash === null) return { kind: "Unknown" };
  const open = "i.token_sha256 = ? AND i.email = ? AND i.expires_at > ?";
  const [, , spent] = await db.batch<{ invitation_id: string; tenant_id: string }>([
    db
      .prepare(
        `INSERT INTO principals (principal_id, email, created_at, updated_at)
        SELECT ?, i.email, ?, ? FROM invitations i WHERE ${open} ON CONFLICT (email) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), now, now, tokenHash, email, now),
    db
      .prepare(
        `INSERT INTO memberships (tenant_id, principal_id, role, created_at)
        SELECT i.tenant_id, p.principal_id, i.role, ? FROM invitations i JOIN principals p ON p.email = i.email
        WHERE ${open} ON CONFLICT DO NOTHING`,
      )
      .bind(now, tokenHash, email, now),
    db
      .prepare(
        "DELETE FROM invitations WHERE token_sha256 = ? AND email = ? AND expires_at > ? RETURNING invitation_id, tenant_id",
      )
      .bind(tokenHash, email, now),
  ]);
  const invitation = spent?.results[0];
  if (invitation !== undefined) {
    const tenantId = invitation.tenant_id;
    const principal = await db
      .prepare(
        "SELECT p.principal_id, m.role FROM principals p JOIN memberships m ON m.principal_id = p.principal_id WHERE p.email = ? AND m.tenant_id = ?",
      )
      .bind(email, tenantId)
      .first<{ principal_id: string; role: Role }>();
    if (principal === null)
      throw new Error(`accepting invitation ${invitation.invitation_id} left ${email} no membership`);
    return {
      kind: "Accepted",
      whoami: await whoamiOf(db, { tenantId, principalId: principal.principal_id, role: principal.role }),
    };
  }
  const row = await db
    .prepare("SELECT invitation_id, email, expires_at FROM invitations WHERE token_sha256 = ?")
    .bind(tokenHash)
    .first<{ invitation_id: string; email: string; expires_at: number }>();
  const refused = judge(row, email, now);
  if (refused === null) throw new Error(`invitation ${row?.invitation_id} is open and was not spent`);
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
    fix: "List the members and remove one of their principalIds",
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
      fix: "List the members; invite an email that is not one of them",
    });
  }
  return json(
    InvitationCreatedSchema.parse({
      invitation: created.invitation,
      acceptUrl: `${url.origin}${ACCEPT_PAGE_PATH}?token=${encodeURIComponent(created.token)}`,
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
    fix: "List the open invitations and revoke one of their ids",
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
  const accepted = await acceptInvitation(env.DB, body.value.token, person.email, Date.now());
  return accepted.kind === "Accepted" ? json(WhoamiSchema.parse(accepted.whoami)) : acceptRefusal(accepted);
};

const handleAcceptPage = async (url: URL, env: Env, person: PersonCheck): Promise<Response> => {
  if (!person.ok) return htmlPage(env, url, 401, (links) => signInAgainPage(links, person.reason, url.href));
  const { email } = person;
  const token = url.searchParams.get("token") ?? "";
  const preview = await previewInvitation(env.DB, token, email, Date.now());
  if (preview.kind === "Open") {
    return htmlPage(env, url, 200, (links) =>
      acceptPage(links, {
        email,
        tenantName: preview.tenantName,
        role: preview.role,
        token,
        next: links.dashboard,
      }),
    );
  }
  if (preview.kind === "Expired") return htmlPage(env, url, 410, (links) => invitationExpiredPage(links, email));
  if (preview.kind === "OtherEmail") {
    return htmlPage(env, url, 403, (links) => invitationOtherEmailPage(links, email, preview.email));
  }
  return htmlPage(env, url, 404, (links) => invitationNotFoundPage(links, email));
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
  if (method === "POST" && pathname === INVITATION_ACCEPT_PATH) {
    return handleAccept(request, url, env, routing.signedIn, routing.sameOrigin, (reason) =>
      routing.signedOut(url, reason),
    );
  }
  const memberId = MEMBER_PATH.exec(pathname)?.[1];
  const invitationId = INVITATION_PATH.exec(pathname)?.[1];
  const known =
    (pathname === MEMBERS_PATH && method === "GET") ||
    (pathname === INVITATIONS_PATH && (method === "GET" || method === "POST")) ||
    (memberId !== undefined && method === "DELETE") ||
    (invitationId !== undefined && method === "DELETE");
  if (!known) return null;
  const caller = await routing.authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (pathname === MEMBERS_PATH) return json(await listMembers(env.DB, caller.tenantId));
  if (memberId !== undefined) return handleRemove(env, caller, decodeURIComponent(memberId));
  if (invitationId !== undefined) return handleRevoke(env, caller, decodeURIComponent(invitationId));
  if (method === "POST") return handleCreate(request, url, env, caller);
  return json(await listInvitations(env.DB, caller.tenantId, Date.now()));
};
