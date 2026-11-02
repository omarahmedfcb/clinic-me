// The audit log viewer — Phase 5 PR 11. Read-only: who did what, when, to which record.
// Field NAMES travel, values never do — `audit_logs` holds to_jsonb(NEW) of every clinical row.

import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { branchContext } from "../../common/branch-context.ts";
import { eventVisible } from "./event-branch-filter.ts";
import { eventReach, type EventReach } from "./event-reach.ts";

export interface AuditCaller {
  tenantId: string;
  actor: ActorContext;
}

/** One row of an audit event. The reader sees these by entity, never in the order they were written. */
export interface AuditEntry {
  id: string;
  actorUserId: string;
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
}

/** The most rows of one event the viewer returns; `entryCount` still says how many there were. */
export const EVENT_ENTRY_LIMIT = 50;

/** One transaction (same actor, same instant): who, when, how many changes, and the first of them. */
export interface AuditEvent {
  at: Date;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  ipAddress: string;
  entryCount: number;
  /** Null in a single-branch clinic, and for an event whose rows all name one branch (§6). */
  reach: EventReach;
  entries: AuditEntry[];
}

export interface AuditPage {
  events: AuditEvent[];
  /** Events, not rows: pagination counts what the reader sees as one line. */
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

interface EventRow {
  at: Date;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  ipAddress: string;
  entryCount: number;
  beforeBranches: boolean;
  unscoped: boolean;
  total: number;
  entryId: string;
  action: string;
  entityType: string;
  entityId: string;
  changedFields: string[] | null;
}

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

  const visible = eventVisible();
  const multiBranch = branchContext.tryGet()?.isMultiBranch ?? false;
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // Tenant isolation is RLS's, not this predicate's: `audit_logs` carries the same policy every
    // other table does, so a second tenant's rows are not there to be filtered out.
    //
    // An event is one transaction: the rows of one actor sharing one instant (`now()` is the
    // transaction's, and the audit trigger and application writes both use it).
    const rows = await tx.$queryRaw<EventRow[]>`
      WITH matching AS (
        SELECT a.*
          FROM audit_logs a
         WHERE (${actorUserId}::uuid IS NULL OR a.actor_user_id = ${actorUserId}::uuid)
           AND (${entityType}::text IS NULL OR a.entity_type = ${entityType}::text)
           AND (${from}::date IS NULL OR a.created_at >= ${from}::date)
           -- The "to" day is inclusive: a reader asking for "up to the 9th" means the whole of it.
           AND (${to}::date IS NULL OR a.created_at < (${to}::date + INTERVAL '1 day'))
      ), events AS (
        SELECT a.tenant_id, a.actor_user_id, a.created_at,
               count(*)::int                           AS entry_count,
               min(a.actor_role)                       AS actor_role,
               min(a.ip_address)                       AS ip_address,
               bool_or(a.scope = 'BEFORE_BRANCHES')    AS before_branches,
               bool_or(a.scope = 'UNSCOPED')           AS unscoped,
               count(*) OVER ()::int                   AS total
          FROM matching a
         GROUP BY a.tenant_id, a.actor_user_id, a.created_at
         ${visible === null ? Prisma.empty : Prisma.sql`HAVING ${visible}`}
         ORDER BY a.created_at DESC, a.actor_user_id
         LIMIT ${limit} OFFSET ${offset}
      )
      SELECT e.created_at         AS "at",
             e.actor_user_id      AS "actorUserId",
             u.full_name          AS "actorName",
             e.actor_role         AS "actorRole",
             e.ip_address         AS "ipAddress",
             e.entry_count        AS "entryCount",
             e.before_branches    AS "beforeBranches",
             e.unscoped           AS "unscoped",
             e.total              AS "total",
             r.id                 AS "entryId",
             r.action             AS "action",
             r.entity_type        AS "entityType",
             r.entity_id          AS "entityId",
             r.changed_fields     AS "changedFields"
        FROM events e
        LEFT JOIN users u ON u.id = e.actor_user_id
       CROSS JOIN LATERAL (
         SELECT m.id,
                m.action::text AS action,
                m.entity_type,
                m.entity_id,
                CASE
                  WHEN m.previous_state IS NULL OR m.new_state IS NULL THEN NULL
                  ELSE ARRAY(
                    SELECT key
                      FROM jsonb_each(m.new_state)
                     WHERE m.new_state -> key IS DISTINCT FROM m.previous_state -> key
                     ORDER BY key
                  )
                END AS changed_fields
           FROM matching m
          WHERE m.tenant_id = e.tenant_id
            AND m.actor_user_id = e.actor_user_id
            AND m.created_at = e.created_at
          -- By entity, never by id: the ids of one statement's rows do not sort in write order.
          ORDER BY m.entity_type, m.entity_id, m.id
          LIMIT ${EVENT_ENTRY_LIMIT}
       ) r
       ORDER BY e.created_at DESC, e.actor_user_id, r.entity_type, r.entity_id, r.id`;

    const events: AuditEvent[] = [];
    let current: AuditEvent | undefined;
    for (const row of rows) {
      if (current === undefined || current.actorUserId !== row.actorUserId || current.at.getTime() !== row.at.getTime()) {
        current = {
          at: row.at,
          actorUserId: row.actorUserId,
          actorName: row.actorName,
          actorRole: row.actorRole,
          ipAddress: row.ipAddress,
          entryCount: row.entryCount,
          reach: eventReach(multiBranch, row.beforeBranches, row.unscoped),
          entries: [],
        };
        events.push(current);
      }
      current.entries.push({
        id: row.entryId,
        actorUserId: row.actorUserId,
        actorRole: row.actorRole,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        changedFields: row.changedFields ?? [],
      });
    }
    return { events, total: rows[0]?.total ?? 0 };
  });
}

export async function auditFilterOptions(caller: AuditCaller): Promise<AuditFilterOptions> {
  const visible = eventVisible();
  const where = visible === null ? Prisma.empty : Prisma.sql`WHERE ${visible}`;
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const [actors, types] = await Promise.all([
      tx.$queryRaw<{ userId: string; fullName: string; role: string }[]>`
        SELECT DISTINCT a.actor_user_id AS "userId",
               coalesce(u.full_name, '—') AS "fullName",
               a.actor_role AS role
          FROM audit_logs a
          LEFT JOIN users u ON u.id = a.actor_user_id
         ${where}
         ORDER BY "fullName" ASC`,
      tx.$queryRaw<{ entityType: string }[]>`
        SELECT DISTINCT a.entity_type AS "entityType" FROM audit_logs a ${where} ORDER BY "entityType" ASC`,
    ]);
    return { actors, entityTypes: types.map((row) => row.entityType) };
  });
}
