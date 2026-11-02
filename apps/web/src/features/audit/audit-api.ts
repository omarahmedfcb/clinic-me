// The audit log viewer — Phase 5 PR 11. Read-only; there is no write call in this file by design.
// Field names travel and values do not: the API never sends a state, so this type cannot hold one.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** One row of an event. Which columns changed travels as names only — the value is what the §8 boundary withholds. */
export interface AuditEntry {
  id: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  changedFields: string[];
}

/** Why an event is not tied to one branch; null in a single-branch clinic and for an event that names its branch. */
export type AuditReach = "UNSCOPED" | "BEFORE_BRANCHES";

/** One transaction: who, when, how many changes, and the first of them (the API caps `entries`). */
export interface AuditEvent {
  at: string;
  actorUserId: string;
  actorName: string | null;
  actorRole: string;
  ipAddress: string;
  /** All of the event's changes, which may be more than `entries` holds. */
  entryCount: number;
  reach: AuditReach | null;
  entries: AuditEntry[];
}

export interface AuditPage {
  events: AuditEvent[];
  /** Events, not rows. */
  total: number;
}

export interface AuditFilterOptions {
  actors: { userId: string; fullName: string; role: string }[];
  entityTypes: string[];
}

export interface AuditQuery {
  actorUserId?: string;
  entityType?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Throws rather than answering with an empty page: "nobody did anything" is a claim. */
export async function loadAuditLog(authFetch: AuthFetch, query: AuditQuery = {}): Promise<AuditPage> {
  const params = new URLSearchParams({
    limit: String(query.limit ?? 50),
    offset: String(query.offset ?? 0),
  });
  for (const key of ["actorUserId", "entityType", "from", "to"] as const) {
    const value = query[key];
    if (value !== undefined && value !== "") params.set(key, value);
  }

  const response = await authFetch(`/api/audit-log?${params.toString()}`);
  if (!response.ok) throw new Error(`GET /audit-log -> ${response.status}`);
  const body = (await response.json()) as Partial<AuditPage>;
  if (!Array.isArray(body.events)) throw new Error("GET /audit-log -> unreadable payload");
  return { events: body.events, total: body.total ?? body.events.length };
}

export async function loadAuditFilters(authFetch: AuthFetch): Promise<AuditFilterOptions> {
  const response = await authFetch("/api/audit-log/filters");
  if (!response.ok) throw new Error(`GET /audit-log/filters -> ${response.status}`);
  const body = (await response.json()) as Partial<AuditFilterOptions>;
  return { actors: body.actors ?? [], entityTypes: body.entityTypes ?? [] };
}
