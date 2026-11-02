// The clinic's side of support sessions (docs/SUPPORT-ACCESS.md, PR 2): admins open, approve, deny and renew; anyone who sees
// the banner may end one. With the clinic's switch off, every call answers as if the feature did not exist.
import { uuidv7 } from "uuidv7";
import type { RefusalCode, RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";

export const SESSION_MS = 60 * 60_000;

export interface SupportCaller {
  tenantId: string;
  actor: ActorContext;
}

export type SessionResult<T> = { ok: true; value: T } | { ok: false; code: RefusalCode; params: RefusalParams };
const notFound = { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "supportSession" as const } };

const VIEW = {
  id: true, status: true, reason: true, approvedAt: true, expiresAt: true, endedAt: true, endReason: true, createdAt: true, renewedFromId: true,
  changesAllowedAt: true,
  operator: { select: { fullName: true } }, approver: { select: { fullName: true } },
} as const;

/** The switch, and the hour: an ACTIVE session past its end is marked EXPIRED before anything reads it. */
export async function settle(tx: TransactionClient, tenantId: string, now: Date): Promise<boolean> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { supportAccessEnabled: true } });
  await tx.$executeRaw`SELECT expire_support_sessions(${tenantId}::uuid, ${now})`;
  return tenant.supportAccessEnabled;
}

export async function listSessions(caller: SupportCaller, now: Date) {
  return withTenant(caller.tenantId, caller.actor, async (tx) =>
    (await settle(tx, caller.tenantId, now)) ? tx.supportSession.findMany({ select: VIEW, orderBy: { createdAt: "desc" }, take: 100 }) : null);
}

/** What the banner shows every staff member while the vendor is inside. */
export async function liveSession(caller: SupportCaller, now: Date) {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    if (!(await settle(tx, caller.tenantId, now))) return null;
    return tx.supportSession.findFirst({ where: { status: "ACTIVE" }, select: { id: true, expiresAt: true, operator: { select: { fullName: true } } } });
  });
}

export async function openSession(caller: SupportCaller, input: { operatorId: string; reason: string }, now: Date): Promise<SessionResult<{ id: string }>> {
  return openSessionIn(caller, input, now).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("a support session is for an active platform admin")) {
      return { ok: false as const, code: "INVALID_FIELD" as const, params: { field: "operatorId" as const } };
    }
    throw error;
  });
}

async function openSessionIn(caller: SupportCaller, input: { operatorId: string; reason: string }, now: Date): Promise<SessionResult<{ id: string }>> {
  return withTenant<SessionResult<{ id: string }>>(caller.tenantId, caller.actor, async (tx) => {
    if (!(await settle(tx, caller.tenantId, now))) return notFound;
    const id = uuidv7();
    await tx.supportSession.create({ data: injected({ id, operatorId: input.operatorId, requestedBy: caller.actor.userId, reason: input.reason.trim(),
      status: "ACTIVE", approvedBy: caller.actor.userId, approvedAt: now, expiresAt: new Date(now.getTime() + SESSION_MS) }) });
    return { ok: true as const, value: { id } };
  });
}

type Transition = "approve" | "deny" | "end" | "renew";

/** One state change, under a row lock; each refuses the states it does not start from. */
export async function changeSession(caller: SupportCaller, sessionId: string, transition: Transition, now: Date, reason?: string): Promise<SessionResult<{ id: string; status: string }>> {
  return withTenant<SessionResult<{ id: string; status: string }>>(caller.tenantId, caller.actor, async (tx) => {
    if (!(await settle(tx, caller.tenantId, now))) return notFound;
    const rows = await tx.$queryRaw<{ status: string; operator_id: string; reason: string }[]>`
      SELECT status::text AS status, operator_id, reason FROM support_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (row === undefined) return notFound;
    const from: Record<Transition, string> = { approve: "REQUESTED", deny: "REQUESTED", end: "ACTIVE", renew: "ACTIVE" };
    if (row.status !== from[transition]) return { ok: false as const, code: "ALREADY_DECIDED" as const, params: { status: row.status } };
    const by = caller.actor.userId;

    if (transition === "approve") {
      await tx.supportSession.update({ where: { id: sessionId }, data: { status: "ACTIVE", approvedBy: by, approvedAt: now, expiresAt: new Date(now.getTime() + SESSION_MS) } });
      return { ok: true as const, value: { id: sessionId, status: "ACTIVE" } };
    }
    if (transition === "deny") {
      await tx.supportSession.update({ where: { id: sessionId }, data: { status: "DENIED", endedAt: now, endedBy: by, endReason: reason?.trim() || "denied by the clinic" } });
      return { ok: true as const, value: { id: sessionId, status: "DENIED" } };
    }
    await tx.supportSession.update({ where: { id: sessionId }, data: { status: "ENDED", endedAt: now, endedBy: by, endReason: transition === "renew" ? "renewed" : reason?.trim() || "ended by the clinic" } });
    if (transition === "end") return { ok: true as const, value: { id: sessionId, status: "ENDED" } };
    const renewed = uuidv7();
    await tx.supportSession.create({ data: injected({ id: renewed, operatorId: row.operator_id, requestedBy: by, reason: row.reason, status: "ACTIVE",
      approvedBy: by, approvedAt: now, expiresAt: new Date(now.getTime() + SESSION_MS), renewedFromId: sessionId }) });
    return { ok: true as const, value: { id: renewed, status: "ACTIVE" } };
  });
}

/** "Allow changes": only the admin who approved the session, only while it is live, and once; a repeat changes nothing. */
export async function allowChanges(caller: SupportCaller, sessionId: string, now: Date): Promise<SessionResult<{ id: string; changesAllowedAt: Date }>> {
  return withTenant<SessionResult<{ id: string; changesAllowedAt: Date }>>(caller.tenantId, caller.actor, async (tx) => {
    if (!(await settle(tx, caller.tenantId, now))) return notFound;
    const rows = await tx.$queryRaw<{ status: string; approved_by: string | null; changes_allowed_at: Date | null }[]>`
      SELECT status::text AS status, approved_by, changes_allowed_at FROM support_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (row === undefined) return notFound;
    if (row.status !== "ACTIVE") return { ok: false as const, code: "ALREADY_DECIDED" as const, params: { status: row.status } };
    if (row.approved_by !== caller.actor.userId) return { ok: false as const, code: "NOT_THE_APPROVER" as const, params: {} };
    if (row.changes_allowed_at !== null) return { ok: true as const, value: { id: sessionId, changesAllowedAt: row.changes_allowed_at } };
    await tx.supportSession.update({ where: { id: sessionId }, data: { changesAllowedAt: now, changesAllowedBy: caller.actor.userId } });
    return { ok: true as const, value: { id: sessionId, changesAllowedAt: now } };
  });
}
