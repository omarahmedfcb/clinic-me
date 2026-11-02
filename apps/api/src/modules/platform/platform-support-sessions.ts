// Support sessions, the operator's side (docs/SUPPORT-ACCESS.md, PR 2): ask a clinic for a session, withdraw the request, list
// one's own. A request notifies the clinic's admins in-system (6.4); it can never approve itself.
import { uuidv7 } from "uuidv7";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withPlatformActor, withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { settle } from "../support/support-sessions.ts";
import { issueSupportToken } from "../auth/jwt.ts";
import { sendOperatorMessage } from "./platform-messages.ts";

export type OperatorSessionResult<T> = { ok: true; value: T } | { ok: false; code: "NOT_FOUND" | "ALREADY_DECIDED" | "ALREADY_IN_THAT_STATE"; params: RefusalParams };
const absent = { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "supportSession" as const } };

const notice = (reason: string): string => `يطلب فريق دعم NOMED الدخول إلى حساب العيادة لمدة ساعة واحدة، بعد موافقة مدير العيادة. السبب: ${reason}`;

export async function requestSupportSession(actor: ActorContext, tenantId: string, reason: string, now: Date): Promise<OperatorSessionResult<{ id: string }>> {
  const asked = await withTenant<OperatorSessionResult<{ id: string }>>(tenantId, actor, async (tx) => {
    if ((await tx.tenant.count({ where: { id: tenantId } })) === 0 || !(await settle(tx, tenantId, now))) return absent;
    if ((await tx.supportSession.count({ where: { operatorId: actor.userId, status: { in: ["REQUESTED", "ACTIVE"] } } })) > 0) {
      return { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: "OPEN" } };
    }
    const id = uuidv7();
    await tx.supportSession.create({ data: injected({ id, operatorId: actor.userId, requestedBy: actor.userId, reason: reason.trim() }) });
    return { ok: true as const, value: { id } };
  });
  if (asked.ok) await sendOperatorMessage(actor, { tenantId, body: notice(reason.trim()) });
  return asked;
}

export async function withdrawSupportRequest(actor: ActorContext, tenantId: string, sessionId: string, now: Date): Promise<OperatorSessionResult<{ id: string; status: string }>> {
  return withTenant<OperatorSessionResult<{ id: string; status: string }>>(tenantId, actor, async (tx) => {
    if (!(await settle(tx, tenantId, now))) return absent;
    const mine = await tx.supportSession.findFirst({ where: { id: sessionId, operatorId: actor.userId }, select: { status: true } });
    if (mine === null) return absent;
    if (mine.status !== "REQUESTED") return { ok: false as const, code: "ALREADY_DECIDED" as const, params: { status: mine.status } };
    await tx.supportSession.update({ where: { id: sessionId }, data: { status: "DENIED", endedAt: now, endedBy: actor.userId, endReason: "withdrawn by the operator" } });
    return { ok: true as const, value: { id: sessionId, status: "DENIED" } };
  });
}

/** A token for one of the operator's own ACTIVE sessions, with time left: the approving admin's membership, never more. */
export async function issueSupportSessionToken(actor: ActorContext, tenantId: string, sessionId: string, now: Date): Promise<OperatorSessionResult<{ token: string; expiresAt: Date }>> {
  return withTenant<OperatorSessionResult<{ token: string; expiresAt: Date }>>(tenantId, actor, async (tx) => {
    if (!(await settle(tx, tenantId, now))) return absent;
    const session = await tx.supportSession.findFirst({ where: { id: sessionId, operatorId: actor.userId, status: "ACTIVE", expiresAt: { gt: new Date(now.getTime() + 30_000) } },
      select: { approvedBy: true, expiresAt: true } });
    if (session === null) return absent;
    const approver = await tx.membership.findFirst({ where: { userId: session.approvedBy!, status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] } }, select: { id: true, role: true } });
    if (approver === null) return absent;
    const token = await issueSupportToken({ sub: actor.userId, membershipId: approver.id, tenantId, role: approver.role, supportSessionId: sessionId }, session.expiresAt!, now);
    return { ok: true as const, value: { token, expiresAt: session.expiresAt! } };
  });
}

export async function listMySupportSessions(actor: ActorContext) {
  return withPlatformActor(actor, (tx) => tx.$queryRaw<Record<string, unknown>[]>`
    SELECT id, tenant_id AS "tenantId", clinic_name AS "clinicName", status::text AS status, reason, approved_at AS "approvedAt",
           expires_at AS "expiresAt", ended_at AS "endedAt", end_reason AS "endReason", created_at AS "createdAt"
      FROM platform_support_sessions()`);
}
