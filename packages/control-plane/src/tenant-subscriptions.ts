import {
  CapacityRefusalCodeSchema,
  type CompleteSubscriptionResultSchema,
  type CreateSubscriptionInputSchema,
  type CreateSubscriptionResultSchema,
  type PauseSubscriptionResultSchema,
  type ResumeSubscriptionResultSchema,
  type SubscriptionFilterSchema,
  type SubscriptionPauseReasonSchema,
  SubscriptionSchema,
} from "@tumpel/schemas";
import { sql as query, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { durableDb } from "./db/client.ts";
import { DELIVERY_BATCH, type DeliveryEvent, deliveryPrompt, subscriptionPrompt } from "./delivery-prompt.ts";
import { listHosts, withReportedHealth } from "./hosts";
import { effectiveHostCapacity } from "./placement.ts";
import { presenceGraceMs, settingsOf } from "./settings.ts";
import { endOfLog, type NewTenantEvent, oldestKept, retentionCutoff } from "./tenant-events.ts";
import {
  type OfferedPrompt,
  type RoomRequirement,
  SESSION_TAG_LIMIT,
  type Session,
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
const REFUSAL_ATTEMPT_LIMIT = 10;
const REFUSAL_RECIPIENT_BATCH = 8;
const CREW_FAILURE_LIMIT = 10;

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
  capacity_event_id: number;
  capacity_retry_at: number;
  state: Subscription["state"];
  variant: string;
  created_at: number;
  updated_at: number;
  events: string;
  crew_tags: string;
};

const SUBSCRIPTION_STATES = `WITH pauses (subscription_id, state, variant) AS (
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
  UNION ALL SELECT subscription_id, state, variant FROM pauses
  UNION ALL SELECT subscription_id, 'Ended', json_object('state', 'Ended', 'reason', reason, 'endedAt', ended_at) FROM subscription_ends
)`;

const crewMatch = (subscription: string, session: string, tags: string): string =>
  `${session} != (SELECT session_id FROM subscriptions WHERE subscription_id = ${subscription})
  AND NOT EXISTS (SELECT 1 FROM subscriptions AS own JOIN subscription_actives AS oa ON oa.subscription_id = own.subscription_id
    WHERE own.session_id = ${session})
  AND NOT EXISTS (SELECT 1 FROM subscription_crew_tags AS c WHERE c.subscription_id = ${subscription}
    AND c.tag NOT IN (SELECT value FROM json_each(${tags})))`;

const refusalMatch = (event: string, subscription: string): string =>
  `(json_extract(${event}.payload, '$.caller.sessionId') = (SELECT session_id FROM subscriptions WHERE subscription_id = ${subscription})
    OR NOT EXISTS (SELECT 1 FROM subscription_crew_tags AS c WHERE c.subscription_id = ${subscription}
      AND c.tag NOT IN (SELECT value FROM json_each(json_extract(${event}.payload, '$.crewTags')))))`;

const successAfter = (subscription: string, after: string): string =>
  `EXISTS (SELECT 1 FROM session_crew_starts AS success JOIN subscriptions AS owner ON owner.session_id = success.session_id
    WHERE owner.subscription_id = ${subscription} AND success.event_id > ${after})`;

const refusalCount = (subscription: string): string =>
  `CASE WHEN ${subscription}.starts_refused_in_a_row = 0 THEN 0 WHEN ${successAfter(`${subscription}.subscription_id`, `${subscription}.capacity_event_id`)} THEN 0 ELSE ${subscription}.starts_refused_in_a_row END`;

const SUBSCRIPTION_SELECT = `${SUBSCRIPTION_STATES} SELECT s.subscription_id, s.session_id, s.prompt, s.goal, s.expires_at,
  MAX(s.cursor_event_id, s.start_refusal_event_id, s.capacity_event_id) AS cursor_event_id,
  s.crew_failures_in_a_row, s.delivery_failures_in_a_row, ${refusalCount("s")} AS starts_refused_in_a_row, s.capacity_event_id, s.capacity_retry_at, st.state, st.variant, s.created_at, s.updated_at,
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

const startRefusals = (retained: number, recipient: SQL): SQL => query`
  SELECT e.event_id, e.payload, e.created_at, NULL AS refusal_event_id, 1 AS refusal_delivery FROM events AS e ${recipient}
  WHERE e.event_id > MAX(recipient.start_refusal_event_id, recipient.capacity_from_event_id) AND e.created_at >= ${retained}
    AND json_extract(e.payload, '$.event') = 'StartRefused'
    AND EXISTS (SELECT 1 FROM subscription_events WHERE subscription_id = recipient.subscription_id AND event = 'StartRefused')
    AND ${query.raw(refusalMatch("e", "recipient.subscription_id"))}
    AND e.event_id = (SELECT MAX(same.event_id) FROM events AS same
      WHERE same.event_id > MAX(recipient.start_refusal_event_id, recipient.capacity_from_event_id) AND same.created_at >= ${retained}
        AND json_extract(same.payload, '$.event') = 'StartRefused'
        AND json_extract(same.payload, '$.refusal.code') = json_extract(e.payload, '$.refusal.code')
        AND ${query.raw(refusalMatch("same", "recipient.subscription_id"))})`;

const roomFits = query`((stranded.host_id IS NOT NULL AND stranded.host_id = room.host_id)
  OR (stranded.host_id IS NULL AND needed.box_memory_mib <= room.memory_mib
    AND (room.disk_empty = 1 OR needed.box_disk_mib <= room.disk_mib)
    AND CASE room.architecture WHEN 'Amd64' THEN needed.amd64 ELSE needed.arm64 END = 1))`;

const firstCapacitySignal = (retained: number): SQL => query`
  SELECT MIN(room.event_id) FROM capacity_rooms AS room JOIN events AS signal ON signal.event_id = room.event_id
  WHERE room.event_id > needed.event_id AND signal.created_at >= ${retained} AND ${roomFits}`;

const matchedRoom = query.raw(`needed.event_id > MAX(recipient.capacity_from_event_id, COALESCE(
  (SELECT event_id FROM session_crew_starts WHERE session_id = recipient.session_id), 0))
  AND ${refusalMatch("refusal", "recipient.subscription_id")}
  AND EXISTS (SELECT 1 FROM subscription_events WHERE subscription_id = recipient.subscription_id AND event = 'CapacityAvailable')`);

const roomRefusals = query`room_refusals AS needed JOIN events AS refusal ON refusal.event_id = needed.event_id
  LEFT JOIN stranded_room_refusals AS stranded ON stranded.event_id = needed.event_id`;

const nextCapacity = (retained: number, recipient: SQL, dueAt?: number): SQL => {
  const due =
    dueAt === undefined
      ? query``
      : query`AND (recipient.capacity_retry_at <= ${dueAt} OR ${query.raw(refusalCount("recipient"))} = 0)`;
  return query`
    SELECT e.event_id, e.payload, e.created_at, needed.event_id AS refusal_event_id, 1 AS refusal_delivery FROM ${roomRefusals} ${recipient}
    JOIN events AS e ON e.event_id = (${firstCapacitySignal(retained)})
    WHERE refusal.created_at >= ${retained} AND e.event_id > recipient.capacity_event_id AND ${matchedRoom} ${due}
    ORDER BY e.event_id, needed.event_id LIMIT 1`;
};

const crewEvents = (retained: number, recipient: SQL): SQL => query`
  SELECT e.event_id, e.payload, e.created_at, NULL AS refusal_event_id, 0 AS refusal_delivery FROM events AS e ${recipient}
  JOIN event_sessions AS es ON es.event_id = e.event_id
  WHERE e.event_id > recipient.cursor_event_id AND e.created_at >= ${retained}
    AND json_extract(e.payload, '$.event') IN (SELECT event FROM subscription_events WHERE subscription_id = recipient.subscription_id)
    AND ${query.raw(crewMatch("recipient.subscription_id", "es.session_id", "es.tags"))}`;

const matchedEvents = (now: number, subscriptionId?: string): SQL => {
  const retained = retentionCutoff(now);
  const recipient =
    subscriptionId === undefined
      ? query``
      : query`JOIN subscriptions AS recipient ON recipient.subscription_id = ${subscriptionId}`;
  const crew = subscriptionId === undefined ? query`` : query`${crewEvents(retained, recipient)} UNION ALL`;
  return query`${crew} SELECT * FROM (
    ${startRefusals(retained, recipient)}
    UNION ALL SELECT * FROM (${nextCapacity(retained, recipient, now)})
  ) WHERE EXISTS (
    SELECT 1 FROM subscriptions AS due WHERE due.subscription_id = ${subscriptionId === undefined ? query.raw("recipient.subscription_id") : query`${subscriptionId}`}
      AND due.refusal_delivery_retry_at <= ${now}
  )`;
};

const runnableRecipient = query`
  EXISTS (SELECT 1 FROM subscription_actives AS active WHERE active.subscription_id = recipient.subscription_id)
  AND EXISTS (SELECT 1 FROM sessions AS target WHERE target.session_id = recipient.session_id AND target.state IN ('Idle', 'Stopped'))
  AND NOT EXISTS (SELECT 1 FROM turns AS t WHERE t.session_id = recipient.session_id AND t.state IN ('Offered', 'Running'))`;

type MatchedEvent = DeliveryEvent & { refusal_event_id: number | null; refusal_delivery: number };
type CapacityCause = "PoolExhausted" | "NoHostAvailable";

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

export abstract class TenantSubscriptions extends TenantSessions {
  private capacityChanged = true;
  private readonly capacityCauses = new Map<string, CapacityCause>();
  private capacityScheduleChanged = false;
  private capacityRetryAt: number | null = null;
  private refusalScanPending = true;

  protected override capacityMayHaveChanged(hostId?: string, cause: CapacityCause = "PoolExhausted"): void {
    this.capacityChanged = true;
    if (hostId !== undefined && (cause === "NoHostAvailable" || !this.capacityCauses.has(hostId)))
      this.capacityCauses.set(hostId, cause);
  }

  private capacityDeadline(now: number): number | null {
    const retained = retentionCutoff(now);
    return (
      durableDb(this.ctx.storage, {}).get<{ retryAt: number | null }>(query`
      SELECT MIN(retry_at) AS retryAt FROM (
        SELECT recipient.refusal_delivery_retry_at AS retry_at FROM subscriptions AS recipient
        WHERE ${runnableRecipient} AND EXISTS (${startRefusals(retained, query``)})
        UNION ALL
        SELECT MAX(recipient.refusal_delivery_retry_at,
          CASE WHEN ${query.raw(refusalCount("recipient"))} = 0 THEN 0 ELSE recipient.capacity_retry_at END)
        FROM subscriptions AS recipient
        WHERE ${runnableRecipient} AND EXISTS (${nextCapacity(retained, query``)})
      )`)?.retryAt ?? null
    );
  }

  protected recordRefusalRequest(event: Extract<NewTenantEvent, { event: "StartRefused" }>, now: number): void {
    const crewTags = event.operation === "Start" ? this.startTags(event.caller, event.crewTags) : event.crewTags;
    if (crewTags.length <= SESSION_TAG_LIMIT) this.appendStartRefusal({ ...event, crewTags }, now);
  }

  protected override appendStartRefusal(
    event: Extract<NewTenantEvent, { event: "StartRefused" }>,
    now: number,
    room?: RoomRequirement,
  ): void {
    this.ctx.storage.transactionSync(() => {
      const eventId = this.appendEvent(event, now);
      if (
        room === undefined ||
        room.image.architectures.length === 0 ||
        !CapacityRefusalCodeSchema.safeParse(event.refusal.code).success
      )
        return;
      const { image, box, hostId } = room;
      const db = durableDb(this.ctx.storage, {});
      db.run(query`INSERT INTO room_refusals (event_id, box_memory_mib, box_disk_mib, amd64, arm64)
        VALUES (${eventId}, ${box.boxMemoryMib}, ${box.boxDiskMib}, ${Number(image.architectures.includes("Amd64"))}, ${Number(image.architectures.includes("Arm64"))})`);
      if (hostId !== undefined)
        db.run(query`INSERT INTO stranded_room_refusals (event_id, host_id) VALUES (${eventId}, ${hostId})`);
      this.capacityMayHaveChanged();
    });
  }

  private pendingRoom(retained: number): SQL {
    return query`
      FROM ${roomRefusals}
      WHERE refusal.created_at >= ${retained} AND (${firstCapacitySignal(retained)}) IS NULL
        AND EXISTS (SELECT 1 FROM subscriptions AS recipient WHERE ${matchedRoom}
          AND NOT EXISTS (SELECT 1 FROM subscription_ends WHERE subscription_id = recipient.subscription_id))`;
  }

  protected override roomRefusalPending(now: number): boolean {
    return (
      durableDb(this.ctx.storage, {}).get(query`SELECT 1 ${this.pendingRoom(retentionCutoff(now))} LIMIT 1`) !==
      undefined
    );
  }

  private async availableCapacity(tenantId: string): Promise<void> {
    if (!this.capacityChanged) return;
    this.capacityChanged = false;
    const causes = new Map(this.capacityCauses);
    this.capacityCauses.clear();
    if (!this.roomRefusalPending(Date.now())) return;
    const hosts = await listHosts(this.env, tenantId);
    const now = Date.now();
    const usage = this.listHostUsage(tenantId);
    const fresh = now - presenceGraceMs(settingsOf(this.env));
    const room = effectiveHostCapacity(withReportedHealth(hosts, usage, fresh), usage, this.heldBoxes(), fresh);
    const db = durableDb(this.ctx.storage, {});
    const host = db.get<Omit<(typeof room)[number], "diskEmpty"> & { diskEmpty: number }>(query`
      WITH host_room AS (
        SELECT json_extract(value, '$.hostId') AS host_id, json_extract(value, '$.architecture') AS architecture,
          json_extract(value, '$.memory') AS memory_mib, json_extract(value, '$.disk') AS disk_mib,
          json_extract(value, '$.diskEmpty') AS disk_empty FROM json_each(${JSON.stringify(room)})
      )
      SELECT host_id AS hostId, architecture, memory_mib AS memory, disk_mib AS disk, disk_empty AS diskEmpty
      FROM host_room AS room
      WHERE EXISTS (SELECT 1 ${this.pendingRoom(retentionCutoff(now))} AND ${roomFits})
      ORDER BY host_id LIMIT 1`);
    if (host === undefined) return;
    this.ctx.storage.transactionSync(() => {
      const eventId = this.appendEvent(
        {
          event: "CapacityAvailable",
          hostId: host.hostId,
          code: this.capacityCauses.get(host.hostId) ?? causes.get(host.hostId) ?? "PoolExhausted",
        },
        now,
      );
      db.run(query`INSERT INTO capacity_rooms (event_id, memory_mib, disk_mib, disk_empty, architecture, host_id)
        VALUES (${eventId}, ${host.memory}, ${host.disk}, ${host.diskEmpty}, ${host.architecture}, ${host.hostId})`);
    });
    this.refusalScanPending = true;
    if (room.length > 1 && this.roomRefusalPending(now)) {
      this.capacityChanged = true;
      for (const [hostId, cause] of causes)
        if (!this.capacityCauses.has(hostId)) this.capacityCauses.set(hostId, cause);
    }
  }

  private queueRefusalDeliveries(now: number): void {
    const recipients = durableDb(this.ctx.storage, {}).all<{ subscriptionId: string }>(query`
      SELECT MIN(recipient.subscription_id) AS subscriptionId FROM subscriptions AS recipient
      WHERE recipient.refusal_delivery_retry_at <= ${now} AND ${runnableRecipient}
        AND EXISTS (${matchedEvents(now)})
      GROUP BY recipient.session_id ORDER BY subscriptionId LIMIT ${REFUSAL_RECIPIENT_BATCH}`);
    this.refusalScanPending = recipients.length === REFUSAL_RECIPIENT_BATCH;
    this.capacityScheduleChanged = true;
    for (const { subscriptionId } of recipients) this.ensureDelivery(subscriptionId, now, true);
  }

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
        `INSERT INTO subscriptions (subscription_id, session_id, prompt, goal, expires_at, cursor_event_id, capacity_from_event_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        subscriptionId,
        create.sessionId,
        create.prompt,
        create.goal,
        create.expiresAt,
        endOfLog(sql),
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
          "UPDATE subscriptions SET crew_failures_in_a_row = 0, delivery_failures_in_a_row = 0, starts_refused_in_a_row = 0, refusal_delivery_attempts = 0, refusal_delivery_retry_at = 0, updated_at = ? WHERE subscription_id = ?",
          now,
          subscriptionId,
        );
        if (this.undeliveredCrew(subscriptionId, now)) this.ensureDelivery(subscriptionId, now);
      });
      this.refusalScanPending = true;
      this.capacityScheduleChanged = true;
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
    if (startedBy.kind !== "Turn") return tags;
    return [...new Set([...this.crewTagsOf(startedBy.sessionId), ...tags])].sort();
  }

  protected override tumpelMcp(sessionId: string): boolean {
    return super.tumpelMcp(sessionId) || this.subscribed(sessionId);
  }

  protected async startDeliveries(tenantId: string): Promise<boolean> {
    await this.availableCapacity(tenantId);
    const now = Date.now();
    if (this.refusalScanPending || (this.capacityRetryAt !== null && this.capacityRetryAt <= now))
      this.queueRefusalDeliveries(now);
    const sessions = durableDb(this.ctx.storage, {}).all<{ sessionId: string }>(query`
      SELECT DISTINCT t.session_id AS sessionId FROM subscription_turns AS st JOIN turns AS t ON t.turn_id = st.turn_id
      JOIN sessions AS session ON session.session_id = t.session_id
      WHERE t.state = 'Offered' AND t.offer_sent = 0 AND session.state IN ('Idle', 'Stopped')
      ORDER BY t.session_id LIMIT ${REFUSAL_RECIPIENT_BATCH}`);
    await Promise.all(
      sessions.map(async ({ sessionId }) => {
        const next = this.ctx.storage.transactionSync(() => this.takeNextWaiting(sessionId, now));
        if (next !== null) await this.startWaiting(tenantId, sessionId, next);
      }),
    );
    if (this.capacityScheduleChanged) {
      this.capacityScheduleChanged = false;
      this.capacityRetryAt = this.capacityDeadline(Date.now());
    }
    return (
      sessions.length === REFUSAL_RECIPIENT_BATCH ||
      this.capacityChanged ||
      (this.capacityRetryAt !== null && this.capacityRetryAt <= Date.now())
    );
  }

  protected override appendEvent(event: NewTenantEvent, now: number): number {
    const eventId = super.appendEvent(event, now);
    if (event.event === "SessionStarted" && event.caller.kind === "Turn") {
      durableDb(this.ctx.storage, {}).run(query`INSERT INTO session_crew_starts (session_id, event_id)
        VALUES (${event.caller.sessionId}, ${eventId}) ON CONFLICT (session_id) DO UPDATE SET event_id = excluded.event_id`);
    }
    if (event.event === "HostOnline") this.capacityMayHaveChanged(event.hostId, "NoHostAvailable");
    if (event.event === "StartRefused") this.refusalScanPending = true;
    if (!("sessionId" in event)) return eventId;
    if (event.event === "TurnCompleted" || event.event === "TurnFailed") this.deliveryEnded(event, now);
    if (event.event === "TurnStarted") this.acknowledgeDelivery(event.turnId, now);
    if (event.event === "SessionArchived" || event.event === "SessionFailed") {
      const ended = event.event;
      for (const row of this.openSubscriptions(event.sessionId)) this.end(row, ended, now);
    }
    this.matchCrew(event, now);
    if ((event.event === "SessionIdle" || event.event === "SessionStopped") && this.subscribed(event.sessionId)) {
      this.refusalScanPending = true;
      this.capacityScheduleChanged = true;
    }
    return eventId;
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

    const now = Date.now();
    const events = durableDb(this.ctx.storage, {}).all<MatchedEvent>(query`
      ${matchedEvents(now, subscriptionId)} ORDER BY event_id LIMIT ${DELIVERY_BATCH}`);
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error("the tenant Durable Object composes a delivery turn but has no name");
    const plan = subscriptionPrompt(row.prompt, row.goal);
    const batch = deliveryPrompt(plan, tenantId, events);
    if (batch?.kind === "Malformed") {
      if (row.state === "Active") this.pause(row, { kind: "DeliveryFailed", turnId: turn.turn_id }, Date.now());
      return { kind: "Uncomposable", cause: batch.cause };
    }
    const prompt = batch?.prompt ?? plan;
    const included = events.filter((event) => batch !== null && event.event_id <= batch.lastEventId);
    const crew = included.findLast((event) => event.refusal_delivery === 0);
    const startRefusal = included.findLast((event) => event.refusal_delivery === 1 && event.refusal_event_id === null);
    const capacity = included.find((event) => event.refusal_event_id !== null);
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE turns SET prompt = ? WHERE turn_id = ?", prompt, turn.turn_id);
      sql.exec(
        `UPDATE subscription_turns SET composed = 1, cursor_event_id = ?, start_refusal_event_id = ?, capacity_event_id = ?, refusal_delivery = ?
          WHERE turn_id = ?`,
        crew?.event_id ?? 0,
        startRefusal?.event_id ?? 0,
        capacity?.event_id ?? 0,
        Number(startRefusal !== undefined || capacity !== undefined),
        turn.turn_id,
      );
    });
    return { kind: "Composed", prompt };
  }

  private acknowledgeDelivery(turnId: string, now: number): void {
    const db = durableDb(this.ctx.storage, {});
    const delivery = db.get<{
      subscriptionId: string;
      cursor: number;
      startRefusal: number;
      capacity: number;
      refusal: number;
    }>(query`
      SELECT subscription_id AS subscriptionId, cursor_event_id AS cursor, capacity_event_id AS capacity,
        start_refusal_event_id AS startRefusal, refusal_delivery AS refusal
      FROM subscription_turns WHERE turn_id = ${turnId} AND composed = 1`);
    if (delivery === undefined) return;
    const row = this.subscriptionRow(delivery.subscriptionId);
    if (row === null) throw new Error(`delivery turn ${turnId} lost its subscription`);
    db.run(query`UPDATE subscriptions SET cursor_event_id = MAX(cursor_event_id, ${delivery.cursor}),
      start_refusal_event_id = MAX(start_refusal_event_id, ${delivery.startRefusal}),
      capacity_event_id = MAX(capacity_event_id, ${delivery.capacity}),
      starts_refused_in_a_row = ${row.starts_refused_in_a_row + Number(delivery.capacity !== 0)},
      capacity_retry_at = ${delivery.capacity === 0 ? row.capacity_retry_at : now + 1000 * 2 ** row.starts_refused_in_a_row},
      refusal_delivery_attempts = CASE WHEN ${delivery.refusal} = 1 THEN 0 ELSE refusal_delivery_attempts END,
      refusal_delivery_retry_at = CASE WHEN ${delivery.refusal} = 1 THEN 0 ELSE refusal_delivery_retry_at END
      WHERE subscription_id = ${delivery.subscriptionId}`);
    if (row.state === "Active" && this.undeliveredCrew(delivery.subscriptionId, now))
      this.ensureDelivery(delivery.subscriptionId, now);
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

  private undeliveredCrew(subscriptionId: string, now: number): boolean {
    return (
      durableDb(this.ctx.storage, {}).get(query`
      SELECT 1 FROM subscriptions AS recipient WHERE recipient.subscription_id = ${subscriptionId}
        AND EXISTS (${crewEvents(retentionCutoff(now), query``)})`) !== undefined
    );
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

  private ensureDelivery(subscriptionId: string, now: number, refusal = false): void {
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
    sql.exec(
      "INSERT INTO subscription_turns (turn_id, subscription_id, refusal_delivery) VALUES (?, ?, ?)",
      turn.turn_id,
      subscriptionId,
      Number(refusal),
    );
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
    if (reason.kind === "StartsRefused") {
      sql.exec(
        "INSERT INTO subscription_starts_refused_pauses (subscription_id, paused_at) VALUES (?, ?)",
        row.subscription_id,
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
      .exec<{ subscription_id: string; refusal_delivery: number; attempts: number }>(
        `SELECT st.subscription_id, st.refusal_delivery AND (st.composed = 0
          OR st.start_refusal_event_id > s.start_refusal_event_id OR st.capacity_event_id > s.capacity_event_id) AS refusal_delivery,
          s.refusal_delivery_attempts AS attempts
          FROM subscription_turns AS st JOIN subscriptions AS s USING (subscription_id) WHERE st.turn_id = ?`,
        event.turnId,
      )
      .toArray();
    if (delivery === undefined) return;
    const { subscription_id: subscriptionId } = delivery;
    sql.exec("DELETE FROM subscription_turns WHERE turn_id = ?", event.turnId);
    this.refusalScanPending = true;
    this.capacityScheduleChanged = true;
    if (delivery.refusal_delivery === 1 && event.event === "TurnFailed") {
      const attempts = delivery.attempts + 1;
      const exhausted = attempts >= REFUSAL_ATTEMPT_LIMIT;
      sql.exec(
        "UPDATE subscriptions SET refusal_delivery_attempts = ?, refusal_delivery_retry_at = ?, updated_at = ? WHERE subscription_id = ?",
        attempts,
        exhausted ? 0 : now + 1000 * 2 ** (attempts - 1),
        now,
        subscriptionId,
      );
      if (exhausted) {
        const row = this.subscriptionRow(subscriptionId);
        if (row?.state === "Active") this.pause(row, { kind: "DeliveryFailed", turnId: event.turnId }, now);
      }
      return;
    }
    sql.exec(
      `UPDATE subscriptions SET delivery_failures_in_a_row = CASE WHEN ?1 THEN delivery_failures_in_a_row + 1 ELSE 0 END,
        updated_at = ?2 WHERE subscription_id = ?3`,
      event.event === "TurnFailed" ? 1 : 0,
      now,
      subscriptionId,
    );
    const row = this.subscriptionRow(subscriptionId);
    if (row === null || row.state !== "Active") return;
    if (row.starts_refused_in_a_row >= 10) {
      this.pause(row, { kind: "StartsRefused" }, now);
      return;
    }
    if (row.delivery_failures_in_a_row >= DELIVERY_FAILURE_LIMIT) {
      this.pause(row, { kind: "DeliveryFailed", turnId: event.turnId }, now);
      return;
    }
    if (this.undeliveredCrew(subscriptionId, now)) this.ensureDelivery(subscriptionId, now);
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
