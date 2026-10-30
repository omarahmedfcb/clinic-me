// The audit log viewer — Phase 5 PR 11. Read-only: who did what, when, to which record.
// Field NAMES travel, values never do — `audit_logs` holds to_jsonb(NEW) of every clinical row.

import { branchContext } from "../../common/branch-context.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { eventReach, type EventReach } from "./event-reach.ts";

export interface AuditCaller {
  tenantId: string;
  actor: ActorContext;
}

export interface AuditEntry {
  id: string;
  at: Date;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  /**
   * Which columns differed between the two states — **names only, never values**.
   *
   * `audit_logs` is a complete mirror of every audited table, diagnoses and notes included, and
   * this viewer is `auditLog.read`: OWNER and ADMIN, both of whom hold `visits.readContent: NONE`.
   * Returning `previous_state` or `new_state` would hand exactly that content to exactly those
   * roles, through a route whose DTO looks innocent. A field name says a field was edited, which is
   * what an audit trail is for; the value is the thing the §8 boundary exists to withhold.
   */
  changedFields: string[];
  ipAddress: string;
  scope: "ONE_BRANCH" | "UNSCOPED" | "BEFORE_BRANCHES";
}

/** One transaction: rows sharing an actor and an instant. Its entries carry no order among themselves. */
export interface AuditEvent {
  at: Date;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  /** Not tied to one branch, or written before branches: null in a single-branch clinic (§6). */
  reach: EventReach;
  /** Every entry the event holds; `entries` carries the first ENTRIES_PER_EVENT of them. */
  entryCount: number;
  entries: AuditEntry[];
}

export interface AuditPage {
  events: AuditEvent[];
  /** Events, not rows: pagination counts transactions. */
  total: number;
}

export interface AuditFilters {
  /** One person. Comes from the picker below, which lists only this clinic's own actors. */
  actorUserId?: string;
  /** One table — `users`, `appointments`, `payments`. The picker lists what actually appears. */
  entityType?: string;
  /** Inclusive calendar days, as `YYYY-MM-DD`. Absent means unbounded on that side. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** What the filter controls offer: this clinic's actors, and the record types that actually occur. */
export interface AuditFilterOptions {
  actors: { userId: string; fullName: string; role: string }[];
  entityTypes: string[];
}

interface Row extends Omit<AuditEntry, "changedFields"> {
  changedFields: string[] | null;
  event: number;
  total: number;
  rn: number;
  entryCount: number;
  beforeBranches: boolean;
  unscoped: boolean;
}

/** An event lists at most this many entries; `entryCount` says how many it holds, and a filter reaches the rest. */
export const ENTRIES_PER_EVENT = 50;
export async function listAuditLog(
  caller: AuditCaller,
  filters: AuditFilters = {},
): Promise<AuditPage> {
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;
  const actorUserId = filters.actorUserId ?? null;
  const entityType = filters.entityType ?? null;
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // Tenant isolation is RLS's, not this predicate's: `audit_logs` carries the same policy every
    // other table does, so a second tenant's rows are not there to be filtered out.
    // A transaction's rows share its actor and now(); grouped on both in one pass, paginated by
    // event, and listed inside an event by entity then action: deterministic, claiming no sequence.
    const rows = await tx.$queryRaw<Row[]>`
      WITH matching AS (
        SELECT a.*
          FROM audit_logs a
         WHERE (${actorUserId}::uuid IS NULL OR a.actor_user_id = ${actorUserId}::uuid)
           AND (${entityType}::text IS NULL OR a.entity_type = ${entityType}::text)
           AND (${from}::date IS NULL OR a.created_at >= ${from}::date)
           -- The "to" day is inclusive: a reader asking for "up to the 9th" means the whole of it.
           AND (${to}::date IS NULL OR a.created_at < (${to}::date + INTERVAL '1 day'))
      ), events AS (
        SELECT actor_user_id, created_at,
               row_number() OVER (ORDER BY created_at DESC, actor_user_id)::int AS event,
               count(*) OVER ()::int AS total
          FROM matching
         GROUP BY actor_user_id, created_at
         ORDER BY created_at DESC, actor_user_id
         LIMIT ${limit} OFFSET ${offset}
      )
      SELECT * FROM (
      SELECT a.id,
             a.created_at     AS at,
             a.actor_user_id  AS "actorUserId",
             u.full_name      AS "actorName",
             a.actor_role     AS "actorRole",
             a.action::text   AS action,
             a.entity_type    AS "entityType",
             a.entity_id      AS "entityId",
             a.ip_address     AS "ipAddress",
             CASE
               WHEN a.previous_state IS NULL OR a.new_state IS NULL THEN NULL
               ELSE ARRAY(
                 SELECT key
                   FROM jsonb_each(a.new_state)
                  WHERE a.new_state -> key IS DISTINCT FROM a.previous_state -> key
                  ORDER BY key
               )
             END              AS "changedFields",
             a.scope::text    AS scope,
             e.event,
             e.total,
             row_number() OVER w AS rn,
             count(*) OVER (PARTITION BY e.event)::int AS "entryCount",
             bool_or(a.scope = 'BEFORE_BRANCHES') OVER (PARTITION BY e.event) AS "beforeBranches",
             bool_or(a.scope = 'UNSCOPED') OVER (PARTITION BY e.event) AS unscoped
        FROM matching a
        JOIN events e ON e.actor_user_id = a.actor_user_id AND e.created_at = a.created_at
        LEFT JOIN users u ON u.id = a.actor_user_id
      WINDOW w AS (PARTITION BY e.event ORDER BY a.entity_type, a.action::text, a.entity_id, a.id)
      ) shown
       WHERE rn <= ${ENTRIES_PER_EVENT}
       ORDER BY event, rn`;

    const multiBranch = branchContext.tryGet()?.isMultiBranch === true;
    const events = new Map<number, AuditEvent>();
    for (const { total: _total, rn: _rn, event, changedFields, entryCount, beforeBranches, unscoped, ...row } of rows) {
      const entry = { ...row, changedFields: changedFields ?? [] };
      const group = events.get(event);
      if (group === undefined) {
        const reach = eventReach(multiBranch, beforeBranches, unscoped);
        events.set(event, { at: row.at, actorUserId: row.actorUserId, actorName: row.actorName, actorRole: row.actorRole, reach, entryCount, entries: [entry] });
      } else {
        group.entries.push(entry);
      }
    }
    return { events: [...events.values()], total: rows[0]?.total ?? 0 };
  });
}

export async function auditFilterOptions(caller: AuditCaller): Promise<AuditFilterOptions> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const [actors, types] = await Promise.all([
      tx.$queryRaw<{ userId: string; fullName: string; role: string }[]>`
        SELECT DISTINCT a.actor_user_id AS "userId",
               coalesce(u.full_name, '—') AS "fullName",
               a.actor_role AS role
          FROM audit_logs a
          LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY "fullName" ASC`,
      tx.$queryRaw<{ entityType: string }[]>`
        SELECT DISTINCT entity_type AS "entityType" FROM audit_logs ORDER BY "entityType" ASC`,
    ]);
    return { actors, entityTypes: types.map((row) => row.entityType) };
  });
}
