// The audit log viewer — Phase 5 PR 11. Read-only: who did what, when, to which record.
// Field NAMES travel, values never do — `audit_logs` holds to_jsonb(NEW) of every clinical row.

import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";

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
}

export interface AuditPage {
  entries: AuditEntry[];
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
  total: number;
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

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // Tenant isolation is RLS's, not this predicate's: `audit_logs` carries the same policy every
    // other table does, so a second tenant's rows are not there to be filtered out.
    const rows = await tx.$queryRaw<Row[]>`
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
             count(*) OVER ()::int AS total
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE (${actorUserId}::uuid IS NULL OR a.actor_user_id = ${actorUserId}::uuid)
         AND (${entityType}::text IS NULL OR a.entity_type = ${entityType}::text)
         AND (${from}::date IS NULL OR a.created_at >= ${from}::date)
         -- The "to" day is inclusive: a reader asking for "up to the 9th" means the whole of it,
         -- and comparing against that date alone would cut the day off at midnight.
         AND (${to}::date IS NULL OR a.created_at < (${to}::date + INTERVAL '1 day'))
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${limit} OFFSET ${offset}`;

    return {
      entries: rows.map(({ total: _total, changedFields, ...row }) => ({
        ...row,
        changedFields: changedFields ?? [],
      })),
      total: rows[0]?.total ?? 0,
    };
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
