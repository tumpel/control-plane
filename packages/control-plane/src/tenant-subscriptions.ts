import { credentialProblem } from "@tumpel/api/credentials";
import {
  type CompleteSubscriptionResultSchema,
  type CreateSubscriptionInputSchema,
  type CreateSubscriptionResultSchema,
  type PauseSubscriptionResultSchema,
  type ResumeSubscriptionResultSchema,
  StartRefusalCodeSchema,
  StartRefusalSchema,
  type SubscriptionFilterSchema,
  type SubscriptionPauseReasonSchema,
  SubscriptionSchema,
} from "@tumpel/schemas";
import { sql as query } from "drizzle-orm";
import type { z } from "zod";
import { boundedTo } from "./bounded-detail.ts";
import { durableDb } from "./db/client.ts";
import { DELIVERY_BATCH, type DeliveryEvent, deliveryPrompt, subscriptionPrompt } from "./delivery-prompt.ts";
import type { Problem } from "./http.ts";
import { stranded, unplaced } from "./placement.ts";
import { releaseUnreadable } from "./releases.ts";
import type { TenantInput } from "./tenant-api.ts";
import { endOfLog, type NewTenantEvent, oldestKept } from "./tenant-events.ts";
import {
  type HostHeadroom,
  type IssueOfSession,
  type NewSession,
  type OfferedPrompt,
  type Sent,
  type Session,
  type SessionStarted,
  type StartedSession,
  type StartedSessionFromIssue,
  TenantSessions,
  type TurnRow,
} from "./tenant-sessions.ts";

export type Subscription = z.infer<typeof SubscriptionSchema>;
type SubscriptionCreate = z.infer<typeof CreateSubscriptionInputSchema>["subscription"];
type SubscriptionFilter = z.infer<typeof SubscriptionFilterSchema>;
type PauseReason = z.infer<typeof SubscriptionPauseReasonSchema>;
type EndReason = Extract<Subscription, { state: "Ended" }>["reason"];
type Created = z.infer<typeof CreateSubscriptionResultSchema>["created"];
type Paused = z.infer<typeof PauseSubscriptionResultSchema>["paused"];
type Resumed = z.infer<typeof ResumeSubscriptionResultSchema>["resumed"];
type Completed = z.infer<typeof CompleteSubscriptionResultSchema>["completed"];

const DELIVERY_FAILURE_LIMIT = 3;
const CREW_FAILURE_LIMIT = 10;
const STARTS_REFUSED_LIMIT = 10;

type SubscriptionRow = {
  subscription_id: string;
  session_id: string;
  prompt: string;
  goal: string;
  expires_at: string;
  cursor_event_id: number;
  crew_failures_in_a_row: number;
  delivery_failures_in_a_row: number;
  starts_refused_in_a_row: number;
  state: Subscription["state"];
  variant: string;
  created_at: number;
  updated_at: number;
  events: string;
  crew_tags: string;
};

const SUBSCRIPTION_STATES = `WITH paused (subscription_id, state, variant) AS (
  SELECT subscription_id, 'Paused', json_object('state', 'Paused',
    'reason', json_object('kind', 'ByRequest', 'message', message), 'pausedAt', paused_at) FROM subscription_requested_pauses
  UNION ALL SELECT subscription_id, 'Paused', json_object('state', 'Paused',
    'reason', json_object('kind', 'DeliveryFailed', 'turnId', turn_id), 'pausedAt', paused_at) FROM subscription_delivery_failed_pauses
  UNION ALL SELECT subscription_id, 'Paused', json_object('state', 'Paused',
    'reason', json_object('kind', 'CrewFailing'), 'pausedAt', paused_at) FROM subscription_crew_failing_pauses
  UNION ALL SELECT subscription_id, 'Paused', json_object('state', 'Paused',
    'reason', json_object('kind', 'StartsRefused'), 'pausedAt', paused_at) FROM subscription_starts_refused_pauses
), states (subscription_id, state, variant) AS (
  SELECT subscription_id, 'Active', json_object('state', 'Active') FROM subscription_actives
  UNION ALL SELECT subscription_id, state, variant FROM paused
  UNION ALL SELECT subscription_id, 'Ended', json_object('state', 'Ended', 'reason', reason, 'endedAt', ended_at) FROM subscription_ends
)`;

const crewMatch = (subscription: string, session: string, tags: string): string =>
  `${session} != (SELECT session_id FROM subscriptions WHERE subscription_id = ${subscription})
  AND NOT EXISTS (SELECT 1 FROM subscriptions AS own JOIN subscription_actives AS oa ON oa.subscription_id = own.subscription_id
    WHERE own.session_id = ${session})
  AND NOT EXISTS (SELECT 1 FROM subscription_crew_tags AS c WHERE c.subscription_id = ${subscription}
    AND c.tag NOT IN (SELECT value FROM json_each(${tags})))`;

const SUBSCRIPTION_SELECT = `${SUBSCRIPTION_STATES} SELECT s.subscription_id, s.session_id, s.prompt, s.goal, s.expires_at, s.cursor_event_id,
  s.crew_failures_in_a_row, s.delivery_failures_in_a_row, s.starts_refused_in_a_row, st.state, st.variant, s.created_at, s.updated_at,
  (SELECT json_group_array(event) FROM (SELECT event FROM subscription_events WHERE subscription_id = s.subscription_id ORDER BY event)) AS events,
  (SELECT json_group_array(tag) FROM (SELECT tag FROM subscription_crew_tags WHERE subscription_id = s.subscription_id ORDER BY tag)) AS crew_tags
  FROM subscriptions AS s JOIN states AS st ON st.subscription_id = s.subscription_id`;

const STATE_TABLES = [
  "subscription_actives",
  "subscription_requested_pauses",
  "subscription_delivery_failed_pauses",
  "subscription_crew_failing_pauses",
  "subscription_starts_refused_pauses",
];

const LIVE_SUBSCRIPTIONS = STATE_TABLES.map((table) => `SELECT subscription_id FROM ${table}`).join(" UNION ALL ");

const toSubscription = (tenantId: string, row: SubscriptionRow): Subscription => {
  const base = {
    subscriptionId: row.subscription_id,
    tenantId,
    sessionId: row.session_id,
    prompt: row.prompt,
    goal: row.goal,
    events: JSON.parse(row.events),
    crewTags: JSON.parse(row.crew_tags),
    expiresAt: row.expires_at,
    cursorEventId: row.cursor_event_id,
    crewFailuresInARow: row.crew_failures_in_a_row,
    deliveryFailuresInARow: row.delivery_failures_in_a_row,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return SubscriptionSchema.parse({ ...base, ...JSON.parse(row.variant) });
};

const signalIndex = (event: string): string =>
  `json_extract(${event}.payload, '$.event') IN ('StartRefused', 'CapacityAvailable')`;

const refusalMatch = (subscription: string, event: string): string =>
  `(json_extract(${event}.payload, '$.caller.sessionId') = (SELECT session_id FROM subscriptions WHERE subscription_id = ${subscription})
  OR NOT EXISTS (SELECT 1 FROM subscription_crew_tags AS c WHERE c.subscription_id = ${subscription}
    AND c.tag NOT IN (SELECT value FROM json_each(${event}.payload, '$.crewTags'))))`;

const roomRefusals = (before: string): string =>
  `SELECT 1 FROM events AS r WHERE ${signalIndex("r")}
    AND json_extract(r.payload, '$.refusal.code') IN ('PoolExhausted', 'NoHostAvailable', 'HostDegraded', 'HostOffline')
    AND r.event_id > COALESCE((SELECT p.event_id FROM events AS p WHERE ${signalIndex("p")}
      AND json_extract(p.payload, '$.event') = 'CapacityAvailable' ${before}
      ORDER BY p.event_id DESC LIMIT 1), 0)`;

const capacityMatch = (subscription: string): string =>
  `EXISTS (${roomRefusals("AND p.event_id < e.event_id")}
    AND r.event_id < e.event_id AND ${refusalMatch(subscription, "r")})`;

const eventMatch = (subscription: string, crew: string): string =>
  `CASE json_extract(e.payload, '$.event')
    WHEN 'StartRefused' THEN ${refusalMatch(subscription, "e")}
    WHEN 'CapacityAvailable' THEN ${capacityMatch(subscription)}
    ELSE ${crew} END`;

const MATCHED_EVENTS = `SELECT e.event_id, e.payload, e.created_at FROM events AS e
  LEFT JOIN event_sessions AS es ON es.event_id = e.event_id
  WHERE e.event_id > ?2
    AND json_extract(e.payload, '$.event') IN (SELECT event FROM subscription_events WHERE subscription_id = ?1)
    AND ${eventMatch("?1", `es.event_id IS NOT NULL AND (${crewMatch("?1", "es.session_id", "es.tags")})`)}`;

const rose = (before: number | null, after: number | null): boolean =>
  before !== null && after !== null && after > before;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

export abstract class TenantSubscriptions extends TenantSessions {
  protected getSubscription(tenantId: string, subscriptionId: string): Subscription | null {
    const row = this.subscriptionRow(subscriptionId);
    return row === null ? null : toSubscription(tenantId, row);
  }

  protected listSubscriptions(tenantId: string, filter: SubscriptionFilter): Subscription[] {
    return this.ctx.storage.sql
      .exec<SubscriptionRow>(
        `${SUBSCRIPTION_SELECT} WHERE (?1 IS NULL OR s.session_id = ?1) AND (?2 IS NULL OR st.state = ?2)
        ORDER BY s.created_at, s.subscription_id`,
        filter.sessionId ?? null,
        filter.state ?? null,
      )
      .toArray()
      .map((row) => toSubscription(tenantId, row));
  }

  protected createSubscription(tenantId: string, create: SubscriptionCreate, now: number): Created {
    const sql = this.ctx.storage.sql;
    const session = durableDb(this.ctx.storage, {}).get<{ state: string }>(
      query`SELECT state FROM sessions WHERE session_id = ${create.sessionId}`,
    );
    if (session === undefined) return { kind: "NotFound" };
    if (session.state === "Archived") return { kind: "Archived" };
    if (session.state === "Failed") return { kind: "Failed" };
    if (create.crewTags.length > 0) {
      const persona = this.subscriptionSession(create.sessionId);
      if (persona === undefined) throw new Error(`session ${create.sessionId} has no persona`);
      if (persona.tumpelMcp !== 1) {
        return { kind: "PersonaLacksTumpelMcp", personaId: persona.personaId, personaName: persona.personaName };
      }
    }
    const subscriptionId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO subscriptions (subscription_id, session_id, prompt, goal, expires_at, cursor_event_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        subscriptionId,
        create.sessionId,
        create.prompt,
        create.goal,
        create.expiresAt,
        endOfLog(sql),
        now,
        now,
      );
      sql.exec("INSERT INTO subscription_actives (subscription_id) VALUES (?)", subscriptionId);
      for (const event of new Set(create.events)) {
        sql.exec("INSERT INTO subscription_events (subscription_id, event) VALUES (?, ?)", subscriptionId, event);
      }
      for (const tag of new Set(create.crewTags)) {
        sql.exec("INSERT INTO subscription_crew_tags (subscription_id, tag) VALUES (?, ?)", subscriptionId, tag);
      }
    });
    return { kind: "Created", subscription: this.presentSubscription(tenantId, subscriptionId) };
  }

  protected pauseSubscription(tenantId: string, subscriptionId: string, message: string, now: number): Paused {
    const row = this.subscriptionRow(subscriptionId);
    if (row === null) return { kind: "NotFound" };
    if (row.state === "Ended") return { kind: "Ended", subscription: toSubscription(tenantId, row) };
    if (row.state === "Active") {
      this.ctx.storage.transactionSync(() => this.pause(row, { kind: "ByRequest", message }, now));
    }
    return { kind: "Changed", subscription: this.presentSubscription(tenantId, subscriptionId) };
  }

  protected resumeSubscription(tenantId: string, subscriptionId: string, now: number): Resumed {
    const row = this.subscriptionRow(subscriptionId);
    if (row === null) return { kind: "NotFound" };
    if (row.state === "Ended") return { kind: "Ended", subscription: toSubscription(tenantId, row) };
    const sql = this.ctx.storage.sql;
    if (row.state === "Paused") {
      if (JSON.parse(row.crew_tags).length > 0) {
        const session = this.subscriptionSession(row.session_id);
        if (session === undefined) throw new Error(`subscription ${subscriptionId} has no session ${row.session_id}`);
        if (session.tumpelMcp !== 1) {
          return { kind: "PersonaLacksTumpelMcp", personaId: session.personaId, personaName: session.personaName };
        }
      }
      const oldest = oldestKept(sql, endOfLog(sql));
      if (row.cursor_event_id < oldest - 1) {
        return { kind: "CursorExpired", cursorEventId: row.cursor_event_id, oldestEventId: oldest };
      }
      this.ctx.storage.transactionSync(() => {
        this.clearState(subscriptionId);
        sql.exec("INSERT INTO subscription_actives (subscription_id) VALUES (?)", subscriptionId);
        sql.exec(
          "UPDATE subscriptions SET crew_failures_in_a_row = 0, delivery_failures_in_a_row = 0, starts_refused_in_a_row = 0, updated_at = ? WHERE subscription_id = ?",
          now,
          subscriptionId,
        );
        if (this.undelivered(subscriptionId)) this.ensureDelivery(subscriptionId, now);
      });
    }
    return { kind: "Changed", subscription: this.presentSubscription(tenantId, subscriptionId) };
  }

  private subscriptionSession(
    sessionId: string,
  ): { personaId: string; personaName: string; tumpelMcp: number } | undefined {
    return durableDb(this.ctx.storage, {}).get<{
      personaId: string;
      personaName: string;
      tumpelMcp: number;
    }>(query`SELECT p.persona_id AS personaId, p.name AS personaName, p.tumpel_mcp AS tumpelMcp
      FROM sessions AS s JOIN personas AS p ON p.persona_id = s.persona_id WHERE s.session_id = ${sessionId}`);
  }

  protected completeSubscription(tenantId: string, subscriptionId: string, now: number): Completed {
    const row = this.subscriptionRow(subscriptionId);
    if (row === null) return { kind: "NotFound" };
    if (row.state === "Ended") return { kind: "Ended", subscription: toSubscription(tenantId, row) };
    this.ctx.storage.transactionSync(() => this.end(row, "GoalMet", now));
    return { kind: "Changed", subscription: this.presentSubscription(tenantId, subscriptionId) };
  }

  protected deleteSubscription(subscriptionId: string, now: number): boolean {
    const row = this.subscriptionRow(subscriptionId);
    if (row === null) return false;
    this.ctx.storage.transactionSync(() => {
      this.cancelDelivery(row, now);
      this.ctx.storage.sql.exec("DELETE FROM subscriptions WHERE subscription_id = ?", subscriptionId);
    });
    return true;
  }

  protected expireSubscriptions(now: number): void {
    const due = this.ctx.storage.sql
      .exec<{ subscription_id: string }>(
        `SELECT s.subscription_id FROM (${LIVE_SUBSCRIPTIONS}) AS live
        CROSS JOIN subscriptions AS s ON s.subscription_id = live.subscription_id
        WHERE CAST(strftime('%s', s.expires_at) AS INTEGER) * 1000 <= ?`,
        now,
      )
      .toArray();
    for (const { subscription_id: subscriptionId } of due) {
      const row = this.subscriptionRow(subscriptionId);
      if (row === null) throw new Error(`subscription ${subscriptionId} vanished while it expired`);
      this.ctx.storage.transactionSync(() => this.end(row, "Expired", now));
    }
  }

  protected crewTagsOf(sessionId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ tag: string }>(
        `SELECT DISTINCT c.tag FROM subscription_crew_tags AS c JOIN subscriptions AS s ON s.subscription_id = c.subscription_id
        JOIN subscription_actives AS a ON a.subscription_id = c.subscription_id
        WHERE s.session_id = ? ORDER BY c.tag`,
        sessionId,
      )
      .toArray()
      .map((row) => row.tag);
  }

  protected subscribed(sessionId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          `SELECT 1 FROM subscriptions AS s JOIN subscription_actives AS a ON a.subscription_id = s.subscription_id
          WHERE s.session_id = ?`,
          sessionId,
        )
        .toArray().length > 0
    );
  }

  protected override startTags(startedBy: Session["startedBy"], tags: string[]): string[] {
    if (startedBy.kind !== "Turn") return [...new Set(tags)].sort();
    return [...new Set([...this.crewTagsOf(startedBy.sessionId), ...tags])].sort();
  }

  protected override tumpelMcp(sessionId: string): boolean {
    return super.tumpelMcp(sessionId) || this.subscribed(sessionId);
  }

  protected override async startSession(
    tenantId: string,
    input: NewSession,
    now: number,
  ): Promise<SessionStarted<StartedSession>> {
    const started = await super.startSession(tenantId, input, now);
    this.recordSuccessfulStart(started, input.startedBy, now);
    return started;
  }

  protected override async startSessionFromIssue(
    tenantId: string,
    input: NewSession,
    issue: IssueOfSession,
    now: number,
  ): Promise<SessionStarted<StartedSessionFromIssue>> {
    const started = await super.startSessionFromIssue(tenantId, input, issue, now);
    this.recordSuccessfulStart(started, input.startedBy, now);
    return started;
  }

  private recordSuccessfulStart(
    started: SessionStarted<StartedSession>,
    caller: Session["startedBy"],
    now: number,
  ): void {
    if (started.kind !== "Started") return;
    const { sessionId } = started.started.session;
    this.ctx.storage.transactionSync(() => this.appendEvent({ event: "SessionStarted", sessionId, caller }, now));
  }

  protected override async sendTurn(input: TenantInput<"sendTurn">): Promise<Sent> {
    const sent = await super.sendTurn(input);
    if (
      sent.kind !== "Unplaced" &&
      sent.kind !== "Stranded" &&
      sent.kind !== "CredentialRefused" &&
      sent.kind !== "ReleaseUnreadable"
    )
      return sent;

    const { tenantId, sessionId, caller, hosts, now } = input;
    const session = this.getSession(tenantId, sessionId);
    if (session === null) throw new Error(`refused send lost its session ${sessionId}`);
    let problem: Problem;
    switch (sent.kind) {
      case "Unplaced":
        problem = unplaced(sent.hosts, "send the turn again").problem;
        break;
      case "Stranded":
        problem = stranded(session, hosts, sent.missingTurnIds).problem;
        break;
      case "CredentialRefused":
        problem = credentialProblem(
          sent.refusal,
          `the secret set of persona ${sent.personaId}`,
          session.harness,
          "send again",
        );
        break;
      case "ReleaseUnreadable":
        problem = releaseUnreadable(sent.detail, "send the turn again");
        break;
    }
    const reason = StartRefusalCodeSchema.safeParse(problem.code);
    if (!reason.success) return sent;
    const refusal = { code: reason.data, detail: boundedTo(StartRefusalSchema.shape.detail.maxLength, problem.detail) };
    this.ctx.storage.transactionSync(() =>
      this.appendEvent(
        {
          event: "StartRefused",
          operation: "Send",
          personaId: session.personaId,
          model: session.model,
          caller,
          crewTags: session.tags,
          refusal,
        },
        now,
      ),
    );
    return sent;
  }

  protected async startDeliveries(tenantId: string): Promise<void> {
    const sessions = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        `SELECT DISTINCT t.session_id FROM subscription_turns AS st JOIN turns AS t ON t.turn_id = st.turn_id
        WHERE t.state = 'Offered' ORDER BY t.session_id`,
      )
      .toArray();
    for (const { session_id: sessionId } of sessions) {
      const now = Date.now();
      const next = this.ctx.storage.transactionSync(() => this.takeNextWaiting(sessionId, now));
      if (next !== null) await this.startWaiting(tenantId, sessionId, next);
    }
  }

  protected override appendEvent(event: NewTenantEvent, now: number): number {
    const eventId = super.appendEvent(event, now);
    if (event.event === "StartRefused" || event.event === "CapacityAvailable") {
      this.wakeSignal(eventId, event.event, now);
      return eventId;
    }
    if (event.event === "SessionStarted") {
      if (event.caller.kind === "Turn") {
        durableDb(this.ctx.storage, {}).run(query`
          UPDATE subscriptions SET starts_refused_in_a_row = 0
          WHERE session_id = ${event.caller.sessionId} AND starts_refused_in_a_row > 0`);
      }
      return eventId;
    }
    if (!("sessionId" in event)) return eventId;
    if (event.event === "TurnStarted") this.acknowledgeDelivery(event.turnId);
    if (event.event === "TurnCompleted" || event.event === "TurnFailed") this.deliveryEnded(event, now);
    if (event.event === "SessionArchived" || event.event === "SessionFailed") {
      const ended = event.event;
      for (const row of this.openSubscriptions(event.sessionId)) this.end(row, ended, now);
    }
    this.matchCrew(event, now);
    if (
      (event.event === "SessionStopped" ||
        event.event === "SessionFailed" ||
        event.event === "SessionArchived" ||
        event.event === "SessionIdle") &&
      this.roomRefusalPending() &&
      (event.event !== "SessionIdle" ||
        this.heldBoxes().some((box) => box.sessionId === event.sessionId && box.evictable))
    ) {
      const host = durableDb(this.ctx.storage, {}).get<{ host_id: string }>(
        query`SELECT host_id FROM sessions WHERE session_id = ${event.sessionId}`,
      );
      if (host === undefined) throw new Error(`session ${event.sessionId} has no host for its capacity signal`);
      this.appendEvent({ event: "CapacityAvailable", hostId: host.host_id, code: "PoolExhausted" }, now);
    }
    return eventId;
  }

  protected override roomRefusalPending(): boolean {
    return durableDb(this.ctx.storage, {}).get(query.raw(`${roomRefusals("")} LIMIT 1`)) !== undefined;
  }

  protected override reportCommitted(hostId: string, before: HostHeadroom | "BecamePresent", now: number): void {
    if (before === "BecamePresent") {
      this.appendEvent({ event: "CapacityAvailable", hostId, code: "NoHostAvailable" }, now);
      return;
    }
    const after = this.hostHeadroom(hostId);
    if (after === undefined) throw new Error(`host ${hostId} has no committed report`);
    if (before.reported_health !== "Healthy" && after.reported_health === "Healthy") {
      this.appendEvent({ event: "CapacityAvailable", hostId, code: "HostDegraded" }, now);
      return;
    }
    if (
      rose(after.memory_held_mib, before.memory_held_mib) ||
      rose(after.disk_held_mib, before.disk_held_mib) ||
      rose(before.memory_budget_mib, after.memory_budget_mib) ||
      rose(before.disk_budget_mib, after.disk_budget_mib)
    ) {
      this.appendEvent({ event: "CapacityAvailable", hostId, code: "PoolExhausted" }, now);
    }
  }

  private wakeSignal(eventId: number, event: "StartRefused" | "CapacityAvailable", now: number): void {
    const db = durableDb(this.ctx.storage, {});
    const recipients = db.all<{ subscription_id: string }>(
      query`SELECT a.subscription_id FROM subscription_actives AS a
        JOIN subscription_events AS se USING (subscription_id)
        CROSS JOIN events AS e
        WHERE e.event_id = ${eventId} AND se.event = ${event} AND ${query.raw(eventMatch("a.subscription_id", "0"))}
        ORDER BY a.subscription_id`,
    );
    for (const { subscription_id: subscriptionId } of recipients) this.ensureDelivery(subscriptionId, now);
  }

  private acknowledgeDelivery(turnId: string): void {
    const db = durableDb(this.ctx.storage, {});
    const delivery = db.get<{ subscription_id: string; last_event_id: number; wake: number }>(
      query`SELECT subscription_id, last_event_id, wake FROM subscription_turns WHERE turn_id = ${turnId}`,
    );
    if (delivery === undefined) return;
    db.run(query`
      UPDATE subscriptions SET cursor_event_id = ${delivery.last_event_id}
      WHERE subscription_id = ${delivery.subscription_id} AND cursor_event_id < ${delivery.last_event_id}`);
    if (delivery.wake === 0) return;
    db.run(query`
      UPDATE subscriptions SET starts_refused_in_a_row = starts_refused_in_a_row + 1
      WHERE subscription_id = ${delivery.subscription_id}`);
    db.run(query`UPDATE subscription_turns SET wake = 0 WHERE turn_id = ${turnId}`);
  }

  protected override offeredPrompt(harness: string, turn: TurnRow): OfferedPrompt {
    const [delivery] = this.ctx.storage.sql
      .exec<{ subscription_id: string; composed: number }>(
        "SELECT subscription_id, composed FROM subscription_turns WHERE turn_id = ?",
        turn.turn_id,
      )
      .toArray();
    if (delivery === undefined) return super.offeredPrompt(harness, turn);
    if (delivery.composed === 1) return { kind: "Composed", prompt: turn.prompt };
    const row = this.subscriptionRow(delivery.subscription_id);
    if (row === null) throw new Error(`delivery turn ${turn.turn_id} lost its subscription`);
    return this.compose(row, turn);
  }

  private compose(row: SubscriptionRow, turn: TurnRow): OfferedPrompt {
    const sql = this.ctx.storage.sql;
    const subscriptionId = row.subscription_id;
    const events = sql
      .exec<DeliveryEvent>(
        `${MATCHED_EVENTS} ORDER BY e.event_id LIMIT ?3`,
        subscriptionId,
        row.cursor_event_id,
        DELIVERY_BATCH,
      )
      .toArray();
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error("the tenant Durable Object composes a delivery turn but has no name");
    const plan = subscriptionPrompt(row.prompt, row.goal);
    const batch = deliveryPrompt(plan, tenantId, events);
    if (batch?.kind === "Malformed") {
      if (row.state === "Active") this.pause(row, { kind: "DeliveryFailed", turnId: turn.turn_id }, Date.now());
      return { kind: "Uncomposable", cause: batch.cause };
    }
    if (batch?.wake && row.starts_refused_in_a_row >= STARTS_REFUSED_LIMIT) {
      if (row.state === "Active") this.pause(row, { kind: "StartsRefused" }, Date.now());
      return {
        kind: "Uncomposable",
        cause: "the subscription claimed ten refusal or capacity deliveries without starting a crew session",
      };
    }
    const prompt = batch?.prompt ?? plan;
    const lastEventId = batch?.lastEventId ?? row.cursor_event_id;
    sql.exec("UPDATE turns SET prompt = ? WHERE turn_id = ?", prompt, turn.turn_id);
    sql.exec(
      "UPDATE subscription_turns SET composed = 1, last_event_id = ?, wake = ? WHERE turn_id = ?",
      lastEventId,
      Number(batch?.wake ?? false),
      turn.turn_id,
    );
    if (row.state === "Active" && this.undeliveredAfter(subscriptionId, lastEventId)) {
      this.ensureDelivery(subscriptionId, Date.now());
    }
    return { kind: "Composed", prompt };
  }

  private subscriptionRow(subscriptionId: string): SubscriptionRow | null {
    const [row] = this.ctx.storage.sql
      .exec<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE s.subscription_id = ?`, subscriptionId)
      .toArray();
    return row ?? null;
  }

  private presentSubscription(tenantId: string, subscriptionId: string): Subscription {
    const subscription = this.getSubscription(tenantId, subscriptionId);
    if (subscription === null) throw new Error(`subscription ${subscriptionId} vanished while it was read back`);
    return subscription;
  }

  private openSubscriptions(sessionId: string): SubscriptionRow[] {
    return this.ctx.storage.sql
      .exec<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE s.session_id = ? AND st.state != 'Ended'`, sessionId)
      .toArray();
  }

  private undelivered(subscriptionId: string): boolean {
    const row = this.subscriptionRow(subscriptionId);
    return row !== null && this.undeliveredAfter(subscriptionId, row.cursor_event_id);
  }

  private undeliveredAfter(subscriptionId: string, eventId: number): boolean {
    return this.ctx.storage.sql.exec(`${MATCHED_EVENTS} LIMIT 1`, subscriptionId, eventId).toArray().length > 0;
  }

  private waitingDelivery(subscriptionId: string): string | null {
    const [row] = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `SELECT st.turn_id FROM subscription_turns AS st JOIN turns AS t ON t.turn_id = st.turn_id
        WHERE st.subscription_id = ? AND t.state = 'Offered' AND st.composed = 0`,
        subscriptionId,
      )
      .toArray();
    return row?.turn_id ?? null;
  }

  private ensureDelivery(subscriptionId: string, now: number): void {
    if (this.waitingDelivery(subscriptionId) !== null) return;
    const sql = this.ctx.storage.sql;
    const [row] = sql
      .exec<{ session_id: string; host_id: string; box_id: string; prompt: string }>(
        `SELECT s.session_id, x.host_id, x.box_id, s.prompt FROM subscriptions AS s
        JOIN sessions AS x ON x.session_id = s.session_id WHERE s.subscription_id = ?`,
        subscriptionId,
      )
      .toArray();
    if (row === undefined) throw new Error(`subscription ${subscriptionId} lost its session while it queued a turn`);
    const turn = this.newTurn(row.session_id, row.host_id, row.box_id, { prompt: row.prompt }, now);
    sql.exec("INSERT INTO subscription_turns (turn_id, subscription_id) VALUES (?, ?)", turn.turn_id, subscriptionId);
  }

  private cancelDelivery(row: SubscriptionRow, now: number): void {
    const sql = this.ctx.storage.sql;
    const waitingIds = new Set(this.waitingTurns(row.session_id));
    const waiting = sql
      .exec<{ turn_id: string }>(
        "SELECT turn_id FROM subscription_turns WHERE subscription_id = ?",
        row.subscription_id,
      )
      .toArray()
      .filter(({ turn_id }) => waitingIds.has(turn_id));
    for (const { turn_id } of waiting) {
      sql.exec("DELETE FROM subscription_turns WHERE turn_id = ?", turn_id);
      this.cancelWaiting(
        row.session_id,
        turn_id,
        "Cancelled",
        "the subscription that queued this turn was paused, completed, ended or deleted, so the turn never ran",
        now,
      );
    }
  }

  private pause(row: SubscriptionRow, reason: PauseReason, now: number): void {
    const sql = this.ctx.storage.sql;
    this.cancelDelivery(row, now);
    this.clearState(row.subscription_id);
    sql.exec("UPDATE subscriptions SET updated_at = ? WHERE subscription_id = ?", now, row.subscription_id);
    if (reason.kind === "ByRequest") {
      sql.exec(
        "INSERT INTO subscription_requested_pauses (subscription_id, message, paused_at) VALUES (?, ?, ?)",
        row.subscription_id,
        reason.message,
        iso(now),
      );
    }
    if (reason.kind === "DeliveryFailed") {
      sql.exec(
        "INSERT INTO subscription_delivery_failed_pauses (subscription_id, turn_id, paused_at) VALUES (?, ?, ?)",
        row.subscription_id,
        reason.turnId,
        iso(now),
      );
    }
    if (reason.kind === "CrewFailing") {
      sql.exec(
        "INSERT INTO subscription_crew_failing_pauses (subscription_id, paused_at) VALUES (?, ?)",
        row.subscription_id,
        iso(now),
      );
    }
    if (reason.kind === "StartsRefused") {
      sql.exec(
        "INSERT INTO subscription_starts_refused_pauses (subscription_id, paused_at) VALUES (?, ?)",
        row.subscription_id,
        iso(now),
      );
    }
    this.appendEvent(
      { event: "SubscriptionPaused", subscriptionId: row.subscription_id, sessionId: row.session_id, reason },
      now,
    );
  }

  private clearState(subscriptionId: string): void {
    for (const table of STATE_TABLES) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table} WHERE subscription_id = ?`, subscriptionId);
    }
  }

  private end(row: SubscriptionRow, reason: EndReason, now: number): void {
    const sql = this.ctx.storage.sql;
    this.cancelDelivery(row, now);
    this.clearState(row.subscription_id);
    sql.exec("UPDATE subscriptions SET updated_at = ? WHERE subscription_id = ?", now, row.subscription_id);
    sql.exec(
      "INSERT INTO subscription_ends (subscription_id, reason, ended_at) VALUES (?, ?, ?)",
      row.subscription_id,
      reason,
      iso(now),
    );
    this.appendEvent(
      { event: "SubscriptionEnded", subscriptionId: row.subscription_id, sessionId: row.session_id, reason },
      now,
    );
  }

  private deliveryEnded(event: { event: "TurnCompleted" | "TurnFailed"; turnId: string }, now: number): void {
    const sql = this.ctx.storage.sql;
    const [delivery] = sql
      .exec<{ subscription_id: string }>(
        "SELECT subscription_id FROM subscription_turns WHERE turn_id = ?",
        event.turnId,
      )
      .toArray();
    if (delivery === undefined) return;
    const { subscription_id: subscriptionId } = delivery;
    sql.exec("DELETE FROM subscription_turns WHERE turn_id = ?", event.turnId);
    sql.exec(
      `UPDATE subscriptions SET delivery_failures_in_a_row = CASE WHEN ?1 THEN delivery_failures_in_a_row + 1 ELSE 0 END,
        updated_at = ?2 WHERE subscription_id = ?3`,
      event.event === "TurnFailed" ? 1 : 0,
      now,
      subscriptionId,
    );
    const row = this.subscriptionRow(subscriptionId);
    if (row === null || row.state !== "Active") return;
    if (row.delivery_failures_in_a_row >= DELIVERY_FAILURE_LIMIT) {
      this.pause(row, { kind: "DeliveryFailed", turnId: event.turnId }, now);
      return;
    }
    if (this.undelivered(subscriptionId)) this.ensureDelivery(subscriptionId, now);
  }

  private matchCrew(event: NewTenantEvent & { sessionId: string }, now: number): void {
    const sql = this.ctx.storage.sql;
    const crewOf = sql
      .exec<{ subscription_id: string; active: number; listed: number }>(
        `SELECT s.subscription_id,
          EXISTS (SELECT 1 FROM subscription_actives AS a WHERE a.subscription_id = s.subscription_id) AS active,
          EXISTS (SELECT 1 FROM subscription_events AS e WHERE e.subscription_id = s.subscription_id AND e.event = ?2) AS listed
        FROM subscriptions AS s
        WHERE s.session_id != ?1
          AND NOT EXISTS (SELECT 1 FROM subscription_ends AS e WHERE e.subscription_id = s.subscription_id)
          AND NOT EXISTS (SELECT 1 FROM subscriptions AS own JOIN subscription_actives AS oa ON oa.subscription_id = own.subscription_id
            WHERE own.session_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM subscription_crew_tags AS c WHERE c.subscription_id = s.subscription_id
            AND NOT EXISTS (SELECT 1 FROM session_tags AS t WHERE t.session_id = ?1 AND t.tag = c.tag))`,
        event.sessionId,
        event.event,
      )
      .toArray();
    for (const crew of crewOf) {
      const subscriptionId = crew.subscription_id;
      if (crew.active === 0) continue;
      if (event.event === "TurnCompleted") {
        sql.exec(
          "UPDATE subscriptions SET crew_failures_in_a_row = 0, updated_at = ? WHERE subscription_id = ?",
          now,
          subscriptionId,
        );
      }
      if (event.event === "TurnFailed" || event.event === "SessionFailed") {
        sql.exec(
          "UPDATE subscriptions SET crew_failures_in_a_row = crew_failures_in_a_row + 1, updated_at = ? WHERE subscription_id = ?",
          now,
          subscriptionId,
        );
        const row = this.subscriptionRow(subscriptionId);
        if (row !== null && row.crew_failures_in_a_row >= CREW_FAILURE_LIMIT) {
          this.pause(row, { kind: "CrewFailing" }, now);
          continue;
        }
      }
      if (crew.listed === 1) this.ensureDelivery(subscriptionId, now);
    }
  }
}
